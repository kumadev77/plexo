import { execFile } from 'node:child_process'
import { access, rm } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { app, Notification } from 'electron'
import type { BrowserContext } from '../../shared/types'
import type { StartVideoRequest, VideoQuality } from '../../shared/video'
import type { DownloadManager } from '../download/downloadManager'
import { probeUrl } from '../download/probe'
import { updateJson } from '../jsonFile'
import { loadSettings } from '../settings'

// yt-dlp only finds the streams: each one is then an ordinary Plexo download, over every network
// picked, and ffmpeg joins video and audio once both are in.

const DEFAULT_YT_DLP = 'D:\\Aplicaciones de Pc\\descargador pro\\yt-dlp.exe'
const RESOLVE_TIMEOUT_MS = 60_000
const MERGE_TIMEOUT_MS = 30 * 60_000

// mp4 + m4a first: they join into an mp4 any player opens. Anything else still joins, into what
// yt-dlp says fits (often webm or mkv).
const FORMATS: Record<VideoQuality, string> = {
  best: 'bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b',
  '1080': 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b',
  '720': 'bv*[height<=720][ext=mp4]+ba[ext=m4a]/bv*[height<=720]+ba/b[height<=720]/bv*+ba/b',
  audio: 'ba[ext=m4a]/ba/b'
}

interface StreamFormat {
  url: string
  ext: string
  http_headers?: Record<string, string>
}

interface ResolvedVideo {
  title: string
  ext: string
  url?: string
  http_headers?: Record<string, string>
  requested_formats?: StreamFormat[]
}

/** A video waiting on its streams: each one's path once it's in, null until then. Kept on disk,
 * so a join still happens when the streams finish after Plexo restarts. */
interface VideoJob {
  output: string
  ffmpeg: string
  parts: Record<string, string | null>
}

function jobsPath(): string {
  return join(app.getPath('userData'), 'video-jobs.json')
}

function jobsFrom(value: unknown): VideoJob[] {
  return Array.isArray(value) ? (value as VideoJob[]) : []
}

function run(file: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout)
        const reason = stderr
          .split(/\r?\n/)
          .filter((line) => /error/i.test(line))
          .pop()
        const failure = new Error(reason?.replace(/^ERROR:\s*/, '') || error.message)
        Object.assign(failure, { code: (error as NodeJS.ErrnoException).code })
        reject(failure)
      }
    )
  })
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  )
}

/** Windows refuses these in a name, and a trailing dot or space. */
function safeName(title: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what's replaced
  const cleaned = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '')
  return cleaned.slice(0, 180) || 'video'
}

async function freePath(dir: string, name: string, ext: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = join(dir, n === 1 ? `${name}.${ext}` : `${name} (${n}).${ext}`)
    if (!(await exists(candidate))) return candidate
  }
}

/** The configured yt-dlp, else the one on PATH; ffmpeg beside it, else on PATH. */
async function tools(): Promise<{ ytDlp: string; ffmpeg: string }> {
  const configured = (await loadSettings()).ytDlpPath ?? DEFAULT_YT_DLP
  const ytDlp = (await exists(configured)) ? configured : 'yt-dlp'
  const beside = join(dirname(configured), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  return { ytDlp, ffmpeg: (await exists(beside)) ? beside : 'ffmpeg' }
}

export class VideoDownloads {
  constructor(private manager: DownloadManager) {
    manager.onCompleted((id, path) => void this.partDone(id, path))
  }

  /** Starts a video's streams as downloads; the id is the first one's, to show its screen. */
  async start(request: StartVideoRequest): Promise<string> {
    const { ytDlp, ffmpeg } = await tools()
    const json = await run(
      ytDlp,
      ['-J', '--no-playlist', '--no-warnings', '-f', FORMATS[request.quality], request.url],
      RESOLVE_TIMEOUT_MS
    ).catch((error: NodeJS.ErrnoException) => {
      throw new Error(
        error.code === 'ENOENT'
          ? 'yt-dlp wasn’t found. Set ytDlpPath in Plexo’s app-settings.json.'
          : `yt-dlp couldn’t read this video: ${error.message}`
      )
    })
    const video = JSON.parse(json) as ResolvedVideo
    const streams: StreamFormat[] =
      video.requested_formats ??
      (video.url ? [{ url: video.url, ext: video.ext, http_headers: video.http_headers }] : [])
    if (streams.length === 0) throw new Error('yt-dlp found nothing to download on this page.')

    const name = safeName(video.title)
    const joined = streams.length > 1
    // Every stream is checked before any starts, so a bad one doesn't leave the other running.
    const probed = await Promise.all(
      streams.map(async (stream) => {
        const userAgent = stream.http_headers?.['User-Agent']
        const browser: BrowserContext = { cookies: [], ...(userAgent && { userAgent }) }
        const probe = await probeUrl(stream.url, browser)
        if (probe.kind !== 'http') throw new Error('This video’s stream isn’t a plain file.')
        return { stream, browser, probe }
      })
    )
    const ids: string[] = []
    for (const [index, { stream, browser, probe }] of probed.entries()) {
      const part = joined ? `${name}.${index === 0 ? 'video' : 'audio'}` : name
      const ext = stream.ext || extname(probe.suggestedFileName).slice(1) || 'bin'
      ids.push(
        await this.manager.start({
          kind: 'http',
          url: probe.finalUrl,
          destinationDir: request.destinationDir,
          suggestedFileName: `${part}.${ext}`,
          totalBytes: probe.totalBytes ?? 0,
          supportsRanges: probe.supportsRanges && probe.totalBytes !== null,
          interfaceIds: request.interfaceIds,
          etag: probe.etag,
          lastModified: probe.lastModified,
          browser
        })
      )
    }
    if (joined) {
      const output = await freePath(request.destinationDir, name, video.ext)
      const parts = Object.fromEntries(ids.map((id) => [id, null]))
      await updateJson(jobsPath(), (current) => [...jobsFrom(current), { output, ffmpeg, parts }])
    }
    return ids[0]
  }

  private async partDone(id: string, path: string): Promise<void> {
    let ready: VideoJob | undefined
    await updateJson(jobsPath(), (current) => {
      const jobs = jobsFrom(current)
      const job = jobs.find((candidate) => id in candidate.parts)
      if (!job) return jobs
      job.parts[id] = path
      if (Object.values(job.parts).every((part) => part !== null)) ready = job
      // Taken off now: a join that fails leaves the streams for the user, not a retry loop.
      return ready ? jobs.filter((candidate) => candidate !== ready) : jobs
    })
    if (ready) await this.join(ready)
  }

  private async join(job: VideoJob): Promise<void> {
    const parts = Object.values(job.parts) as string[]
    const inputs = parts.flatMap((part) => ['-i', part])
    const maps = parts.flatMap((_, index) => ['-map', `${index}:${index === 0 ? 'v:0' : 'a:0'}`])
    try {
      await run(
        job.ffmpeg,
        ['-y', '-loglevel', 'error', ...inputs, ...maps, '-c', 'copy', job.output],
        MERGE_TIMEOUT_MS
      )
      await Promise.all(parts.map((part) => rm(part, { force: true })))
      new Notification({ title: 'Video ready', body: job.output }).show()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      new Notification({
        title: 'Couldn’t join the video',
        body: `${reason}. Its video and audio stay in the folder.`
      }).show()
    }
  }
}

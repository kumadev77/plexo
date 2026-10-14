import { execFile } from 'node:child_process'
import { access, rm } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { app, Notification } from 'electron'
import type { BrowserContext } from '../../shared/types'
import type { StartVideoRequest, VideoInfo, VideoQuality } from '../../shared/video'
import type { DownloadManager } from '../download/downloadManager'
import { probeUrl } from '../download/probe'
import { readJson, updateJson } from '../jsonFile'
import type { NetworkMonitor } from '../network/interfaces'
import { loadSettings } from '../settings'

// yt-dlp only finds the streams: each one is then an ordinary Plexo download, and ffmpeg joins
// video and audio once both are in (or turns audio into mp3).
//
// YouTube's stream links carry the IP address that asked for them and refuse any other, so a
// video downloads over one network, with yt-dlp asking from that same network's address. The
// links also run out after some hours: a stream that fails gets a fresh one from yt-dlp.

const DEFAULT_YT_DLP = 'D:\\Aplicaciones de Pc\\descargador pro\\yt-dlp.exe'
const RESOLVE_TIMEOUT_MS = 60_000
const CONVERT_TIMEOUT_MS = 30 * 60_000
/** Fresh links a stream gets on its own before it's left for the user's Fix link. */
const AUTO_RELINKS = 3
const RELINK_DELAY_MS = 1500

/** yt-dlp's format selector for `quality`. mp4 + m4a first: they join into an mp4 any player
 * opens; anything else still joins, into what yt-dlp says fits (webm or mkv). */
function formatFor(quality: VideoQuality): string {
  if (quality === 'audio' || quality === 'mp3') return 'ba[ext=m4a]/ba'
  if (quality === 'best') return 'bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b'
  const height = `[height=${parseInt(quality, 10)}]`
  return `bv*${height}[ext=mp4]+ba[ext=m4a]/bv*${height}+ba/b${height}`
}

interface StreamFormat {
  url: string
  ext: string
  format_id: string
  http_headers?: Record<string, string>
}

interface ResolvedVideo extends Partial<StreamFormat> {
  title: string
  ext: string
  duration?: number
  requested_formats?: StreamFormat[]
  formats?: { height?: number | null; vcodec?: string; acodec?: string }[]
}

/** Something to do once every one of its downloads is in: each one's path, null until then. */
interface VideoJob {
  mode: 'join' | 'mp3'
  output: string
  ffmpeg: string
  parts: Record<string, string | null>
}

/** How to get a fresh link for one stream's download, by its id. */
interface StreamSource {
  page: string
  formatId: string
  sourceAddress?: string
  relinks: number
}

interface Saved {
  jobs: VideoJob[]
  streams: Record<string, StreamSource>
}

function savedPath(): string {
  return join(app.getPath('userData'), 'video-downloads.json')
}

function savedFrom(value: unknown): Saved {
  const saved = (typeof value === 'object' && value !== null ? value : {}) as Partial<Saved>
  return {
    jobs: Array.isArray(saved.jobs) ? saved.jobs : [],
    streams: typeof saved.streams === 'object' && saved.streams !== null ? saved.streams : {}
  }
}

function update(change: (saved: Saved) => void): Promise<void> {
  return updateJson(savedPath(), (current) => {
    const saved = savedFrom(current)
    change(saved)
    return saved
  })
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

async function ytDlp(args: string[]): Promise<string> {
  const { ytDlp } = await tools()
  return run(ytDlp, ['--no-playlist', '--no-warnings', ...args], RESOLVE_TIMEOUT_MS).catch(
    (error: NodeJS.ErrnoException) => {
      throw new Error(
        error.code === 'ENOENT'
          ? 'yt-dlp wasn’t found. Set ytDlpPath in Plexo’s app-settings.json.'
          : `yt-dlp couldn’t read this video: ${error.message}`
      )
    }
  )
}

const sourceArgs = (address: string | undefined): string[] =>
  address ? ['--source-address', address] : []

export class VideoDownloads {
  constructor(
    private manager: DownloadManager,
    private networks: NetworkMonitor
  ) {
    manager.onCompleted((id, path) => void this.partDone(id, path))
    manager.onFailed((id) => void this.autoRelink(id))
  }

  /** The heights and audio a video comes in, for New download to offer. */
  async inspect(url: string): Promise<VideoInfo> {
    const video = JSON.parse(await ytDlp(['-J', url])) as ResolvedVideo
    const formats = video.formats ?? []
    const heights = new Set<number>()
    for (const format of formats) {
      if (format.vcodec !== 'none' && format.height) heights.add(format.height)
    }
    return {
      title: video.title,
      heights: [...heights].sort((a, b) => b - a),
      hasAudio: formats.some((format) => format.acodec && format.acodec !== 'none'),
      durationSeconds: video.duration
    }
  }

  /** The IPv4 address of the network a video downloads over: yt-dlp asks from it too. */
  private async addressOf(networkId: string): Promise<string | undefined> {
    const network = (await this.networks.refresh()).find((iface) => iface.id === networkId)
    return network?.addresses.find((address) => address.family === 4)?.address
  }

  /** Starts a video's streams as downloads; the id is the first one's, to show its screen. */
  async start(request: StartVideoRequest): Promise<string> {
    const network = request.interfaceIds[0]
    if (!network) throw new Error('Select a network')
    const sourceAddress = await this.addressOf(network)
    const video = JSON.parse(
      await ytDlp([
        '-J',
        '-f',
        formatFor(request.quality),
        ...sourceArgs(sourceAddress),
        request.url
      ])
    ) as ResolvedVideo
    const streams: StreamFormat[] =
      video.requested_formats ??
      (video.url
        ? [
            {
              url: video.url,
              ext: video.ext,
              format_id: video.format_id ?? '',
              http_headers: video.http_headers
            }
          ]
        : [])
    if (streams.length === 0) {
      throw new Error(
        /^\d+p$/.test(request.quality)
          ? `This video doesn’t come in ${request.quality}. Pick another quality.`
          : 'yt-dlp found nothing to download on this page.'
      )
    }

    const name = safeName(video.title)
    const joined = streams.length > 1
    const mp3 = request.quality === 'mp3'
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
          interfaceIds: [network],
          etag: probe.etag,
          lastModified: probe.lastModified,
          browser
        })
      )
    }
    const { ffmpeg } = await tools()
    const job: VideoJob | undefined = joined
      ? {
          mode: 'join',
          output: await freePath(request.destinationDir, name, video.ext),
          ffmpeg,
          parts: Object.fromEntries(ids.map((id) => [id, null]))
        }
      : mp3
        ? {
            mode: 'mp3',
            output: await freePath(request.destinationDir, name, 'mp3'),
            ffmpeg,
            parts: { [ids[0]]: null }
          }
        : undefined
    await update((saved) => {
      if (job) saved.jobs.push(job)
      for (const [index, id] of ids.entries()) {
        saved.streams[id] = {
          page: request.url,
          formatId: streams[index].format_id,
          sourceAddress,
          relinks: 0
        }
      }
    })
    return ids[0]
  }

  /** Whether `id` is one of a video's streams: its link comes from yt-dlp, not the user. */
  async owns(id: string): Promise<boolean> {
    return id in savedFrom(await readJson(savedPath())).streams
  }

  /** Asks yt-dlp for a fresh link to a stream, and resumes its download from where it stopped. */
  async relink(id: string): Promise<void> {
    const source = savedFrom(await readJson(savedPath())).streams[id]
    if (!source) throw new Error('This isn’t one of a video’s downloads.')
    const urls = await ytDlp([
      '-g',
      '-f',
      source.formatId,
      ...sourceArgs(source.sourceAddress),
      source.page
    ])
    const url = urls.split(/\r?\n/).find((line) => /^https?:\/\//.test(line))
    if (!url) throw new Error('yt-dlp gave no new link for this video.')
    await this.manager.relink(id, url)
  }

  private async autoRelink(id: string): Promise<void> {
    let allowed = false
    await update((saved) => {
      const source = saved.streams[id]
      if (!source || source.relinks >= AUTO_RELINKS) return
      source.relinks++
      allowed = true
    })
    if (!allowed) return
    // The run winds down after it fails; relink takes a download once it's stopped.
    await new Promise((resolve) => setTimeout(resolve, RELINK_DELAY_MS))
    await this.relink(id).catch((error) =>
      console.error('[plexo] video: no fresh link for', id, error)
    )
  }

  private async partDone(id: string, path: string): Promise<void> {
    let ready: VideoJob | undefined
    await update((saved) => {
      delete saved.streams[id]
      const job = saved.jobs.find((candidate) => id in candidate.parts)
      if (!job) return
      job.parts[id] = path
      if (Object.values(job.parts).every((part) => part !== null)) ready = job
      // Taken off now: one that fails leaves the files for the user, not a retry loop.
      if (ready) saved.jobs = saved.jobs.filter((candidate) => candidate !== ready)
    })
    if (ready) await this.finish(ready)
  }

  private async finish(job: VideoJob): Promise<void> {
    const parts = Object.values(job.parts) as string[]
    const inputs = parts.flatMap((part) => ['-i', part])
    const args =
      job.mode === 'mp3'
        ? [...inputs, '-vn', '-c:a', 'libmp3lame', '-q:a', '2']
        : [
            ...inputs,
            ...parts.flatMap((_, index) => ['-map', `${index}:${index === 0 ? 'v:0' : 'a:0'}`]),
            '-c',
            'copy'
          ]
    try {
      await run(job.ffmpeg, ['-y', '-loglevel', 'error', ...args, job.output], CONVERT_TIMEOUT_MS)
      await Promise.all(parts.map((part) => rm(part, { force: true })))
      // Finished shows the one file made, under the first download's entry, not the parts.
      const [first, ...rest] = Object.keys(job.parts)
      await this.manager.replaceFinished(first, job.output, rest)
      new Notification({ title: 'Video ready', body: job.output }).show()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      new Notification({
        title: job.mode === 'mp3' ? 'Couldn’t make the mp3' : 'Couldn’t join the video',
        body: `${reason}. The downloaded files stay in the folder.`
      }).show()
    }
  }
}

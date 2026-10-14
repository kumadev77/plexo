// Video pages (YouTube) aren't files: yt-dlp finds the streams behind them, Plexo downloads each
// stream as an ordinary HTTP download, and ffmpeg joins video and audio once both are in.

/** `best`, a height such as `1080p`, or audio only: as it comes (m4a) or turned into mp3. */
export type VideoQuality = 'best' | `${number}p` | 'audio' | 'mp3'

/** What New download offers for a video, read by yt-dlp before anything starts. */
export interface VideoInfo {
  title: string
  /** Every height the video comes in, tallest first. */
  heights: number[]
  hasAudio: boolean
  durationSeconds?: number
}

export interface StartVideoRequest {
  url: string
  quality: VideoQuality
  destinationDir: string
  interfaceIds: string[]
}

/** Every choice for `info`, in the order shown. */
export function videoQualities(info: VideoInfo): { value: VideoQuality; label: string }[] {
  return [
    { value: 'best', label: 'Best' },
    ...info.heights.map((height) => ({ value: `${height}p` as const, label: `${height}p` })),
    ...(info.hasAudio
      ? [
          { value: 'audio' as const, label: 'Audio (M4A)' },
          { value: 'mp3' as const, label: 'Audio (MP3)' }
        ]
      : [])
  ]
}

const VIDEO_HOSTS = /^(www\.|m\.|music\.)?(youtube\.com|youtube-nocookie\.com|youtu\.be)$/i

/** A page yt-dlp is needed for, rather than a file Plexo can fetch itself. */
export function isVideoPageUrl(candidate: string): boolean {
  let url: URL
  try {
    url = new URL(candidate.trim())
  } catch {
    return false
  }
  if (!/^https?:$/.test(url.protocol) || !VIDEO_HOSTS.test(url.hostname)) return false
  if (/youtu\.be$/i.test(url.hostname)) return url.pathname.length > 1
  return (
    (url.pathname === '/watch' && url.searchParams.has('v')) ||
    /^\/(shorts|live|embed)\/[\w-]+/.test(url.pathname)
  )
}

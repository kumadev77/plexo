// Video pages (YouTube) aren't files: yt-dlp finds the streams behind them, Plexo downloads each
// stream as an ordinary HTTP download, and ffmpeg joins video and audio once both are in.

export type VideoQuality = 'best' | '1080' | '720' | 'audio'

export const VIDEO_QUALITIES: { value: VideoQuality; label: string }[] = [
  { value: 'best', label: 'Best' },
  { value: '1080', label: '1080p' },
  { value: '720', label: '720p' },
  { value: 'audio', label: 'Audio only' }
]

export interface StartVideoRequest {
  url: string
  quality: VideoQuality
  destinationDir: string
  interfaceIds: string[]
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

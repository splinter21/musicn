import got from 'got'
import cliProgress from 'cli-progress'
import prettyBytes from 'pretty-bytes'
import { red, green } from 'colorette'
import { pipeline } from 'node:stream/promises'
import { join, basename } from 'node:path'
import { existsSync, mkdirSync, createWriteStream, unlinkSync } from 'node:fs'
import lyric from './services/lyric'
import { type SongInfo } from './types'

const barList: cliProgress.SingleBar[] = []
const songNameMap = new Map<string, number>()
const unfinishedPathMap = new Map<string, string>()

const multiBar = new cliProgress.MultiBar({
  format: '[\u001b[32m{bar}\u001b[0m] | {file} | {value}/{total}',
  hideCursor: true,
  barCompleteChar: '#',
  barIncompleteChar: '#',
  barGlue: '\u001b[33m',
  barsize: 30,
  stopOnComplete: true,
  noTTYOutput: true,
  forceRedraw: true,
  formatValue(value, _, type) {
    if (type === 'total' || type === 'value') {
      return prettyBytes(Number(value))
    }
    return String(value)
  },
})

const downloadSong = (song: SongInfo, index: number) => {
  let { songName, songDownloadUrl, lyricDownloadUrl, songSize, options } = song
  const { lyric: withLyric = false, path: targetDir = process.cwd(), service } = options
  return new Promise<boolean>(async (resolve) => {
    // 防止因歌曲名重名导致下载时被覆盖
    if (songNameMap.has(songName)) {
      songNameMap.set(songName, Number(songNameMap.get(songName)) + 1)
      const [name, extension] = songName.split('.')
      const newName = `${name}(${songNameMap.get(songName)})`
      songName = `${newName}.${extension}`
    } else {
      songNameMap.set(songName, 0)
    }
    const songPath = join(targetDir, songName)
    const lrcPath = join(targetDir, `${songName.split('.')[0]}.lrc`)

    barList.push(multiBar.create(songSize, 0, { file: songName }))

    unfinishedPathMap.set(songPath, '')

    if (!existsSync(targetDir)) mkdirSync(targetDir)

    if (withLyric) {
      await lyric[service](lrcPath, lyricDownloadUrl).catch(() => {
        createWriteStream(lrcPath).write('[00:00.00]无歌词')
      })
    }

    const onError = (err: any, songPath: string) => {
      let timer = setInterval(() => {
        const bar: any = barList[index]
        const STEP_COUNT = 49999
        bar.options.format = '[\u001b[31m{bar}\u001b[0m] | {file} | {value}/{total}'
        if (songSize - bar.value >= STEP_COUNT) {
          return bar.increment(STEP_COUNT)
        }
        bar.increment(songSize - bar.value)
        clearInterval(timer)
      }, 3)
      if (unfinishedPathMap.has(songPath)) unfinishedPathMap.set(songPath, err)
    }

    try {
      const fileReadStream = got.stream(songDownloadUrl)
      fileReadStream.on('response', async () => {
        // 防止`onError`被调用两次
        fileReadStream.off('error', (err) => {
          onError(err, songPath)
        })

        await pipeline(fileReadStream, createWriteStream(songPath))
        unfinishedPathMap.delete(songPath)
        resolve(true)
      })

      fileReadStream.on('downloadProgress', ({ transferred }) => {
        barList[index].update(transferred)
      })

      fileReadStream.once('error', (err) => {
        onError(err, songPath)
      })
    } catch (err) {
      onError(err, songPath)
    }
  })
}

const download = (songs: SongInfo[]) => {
  console.log(green('下载开始...'))
  multiBar.on('stop', () => {
    let errorMessage = ''
    const { size } = unfinishedPathMap
    if (size) {
      errorMessage = Array.from(unfinishedPathMap.entries()).reduce((pre, cur, index) => {
        pre += `\n${index + 1}.${basename(cur[0])}下载失败，报错信息：${cur[1]}`
        return pre
      }, '失败信息：')
    }
    console.log(
      green(
        `下载完成，成功 ${songs.length - size} 首，失败 ${size} 首${size ? '\n' : ''}${red(
          errorMessage
        )}`
      )
    )
  })
  // 多种信号事件触发执行清理操作
  ;['exit', 'SIGINT', 'SIGHUP', 'SIGBREAK', 'SIGTERM'].forEach((eventType) => {
    process.on(eventType, () => {
      // 删除已创建但未下载完全的文件
      for (const item of unfinishedPathMap.keys()) {
        if (existsSync(item)) unlinkSync(item)
      }
      process.exit()
    })
  })
  return Promise.all(songs.map((song, index) => downloadSong(song, index)))
}
export default download

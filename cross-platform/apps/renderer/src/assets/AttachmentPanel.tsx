import { useEffect, useRef, useState } from 'react'
import { Button } from '@fluentui/react-components'
import { Attach20Regular, Mic20Regular, Stop20Regular } from '@fluentui/react-icons'
import type { Asset } from '@notebook/domain'
import { ActionMenu } from '../ActionMenu'
import { insertAssetIntoEditor } from './assetCommands'

interface AttachmentPanelProps {
  pageId: string
  loadAssets(pageId: string): Promise<Asset[]>
  saveAsset(pageId: string, file: File): Promise<Asset>
  openAsset(asset: Asset): Promise<void>
}

export function AttachmentPanel({ pageId, loadAssets, saveAsset, openAsset }: AttachmentPanelProps) {
  const input = useRef<HTMLInputElement>(null)
  const recorder = useRef<MediaRecorder | undefined>(undefined)
  const chunks = useRef<Blob[]>([])
  const [assets, setAssets] = useState<Asset[]>([])
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string>()
  const reload = () => void loadAssets(pageId).then(setAssets)
  useEffect(() => {
    void loadAssets(pageId).then(setAssets)
  }, [loadAssets, pageId])

  const addFiles = async (files: File[]) => {
    for (const file of files) {
      const asset = await saveAsset(pageId, file)
      insertAssetIntoEditor(pageId, asset)
    }
    reload()
  }
  const toggleRecording = async () => {
    if (recorder.current?.state === 'recording') { recorder.current.stop(); return }
    try {
      setError(undefined)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mediaRecorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : undefined })
      chunks.current = []
      mediaRecorder.ondataavailable = (event) => { if (event.data.size) chunks.current.push(event.data) }
      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks.current, { type: mediaRecorder.mimeType })
        stream.getTracks().forEach((track) => track.stop())
        setRecording(false)
        void addFiles([new File([blob], `录音-${new Date().toISOString().replaceAll(':', '-')}.webm`, { type: blob.type })]).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '录音保存失败'))
      }
      recorder.current = mediaRecorder
      mediaRecorder.start(1000)
      setRecording(true)
    } catch (reason) {
      setRecording(false)
      setError(reason instanceof Error ? reason.message : '无法使用麦克风，请检查系统权限')
    }
  }

  return <div className="attachment-panel">
    <input ref={input} hidden type="file" multiple onChange={(event) => { void addFiles([...(event.target.files ?? [])]); event.target.value = '' }} />
    <ActionMenu label="附件操作" trigger={<Button size="small" appearance="subtle" icon={<Attach20Regular />}>附件{assets.length ? ` (${assets.length})` : ''}</Button>}><button onClick={() => input.current?.click()}>添加附件…</button>{assets.map((asset) => <button key={asset.id} onClick={() => void openAsset(asset)}>{asset.kind === 'audio' ? '🎙️' : asset.kind === 'image' ? '🖼️' : '📎'} {asset.filename}{asset.byteSize !== undefined ? ` · ${formatBytes(asset.byteSize)}` : ''}</button>)}</ActionMenu>
    <Button size="small" appearance={recording ? 'primary' : 'subtle'} icon={recording ? <Stop20Regular /> : <Mic20Regular />} onClick={() => void toggleRecording()}>{recording ? '停止录音' : '录音'}</Button>
    {error && <span className="attachment-error" role="alert">{error}</span>}
  </div>
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

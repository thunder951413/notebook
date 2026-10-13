// The bridge must exist before any renderer module reads window.notebookDesktop.
import './bridge'
import '../../renderer/src/main.tsx'
import { invoke } from '@tauri-apps/api/core'

// The window starts hidden; show it once the first frame has been painted so
// the app never flashes an empty window.
requestAnimationFrame(() => requestAnimationFrame(() => { void invoke('app_ready') }))

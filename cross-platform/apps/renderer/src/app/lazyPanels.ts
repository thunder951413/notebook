import { lazy } from 'react'

// Panels that are only visible when opened are loaded on demand so the initial
// render stays lean. The editor, tree rows and rail stay on the critical path.
export const TaskDetail = lazy(() => import('../tasks/TaskDetail').then((module) => ({ default: module.TaskDetail })))
export const AttachmentPanel = lazy(() => import('../assets/AttachmentPanel').then((module) => ({ default: module.AttachmentPanel })))
export const VersionHistory = lazy(() => import('../history/VersionHistory').then((module) => ({ default: module.VersionHistory })))
export const SettingsCenter = lazy(() => import('../settings/SettingsCenter').then((module) => ({ default: module.SettingsCenter })))
export const CommandPalette = lazy(() => import('../CommandPalette').then((module) => ({ default: module.CommandPalette })))
export const ReferencePicker = lazy(() => import('../editor/ReferencePicker').then((module) => ({ default: module.ReferencePicker })))
export const BacklinksSidebar = lazy(() => import('../editor/BacklinksPanel').then((module) => ({ default: module.BacklinksSidebar })))
export const OutlineSidebar = lazy(() => import('../editor/OutlinePanel').then((module) => ({ default: module.OutlineSidebar })))
export const ReferenceHelpDialog = lazy(() => import('../editor/ReferenceHelpDialog').then((module) => ({ default: module.ReferenceHelpDialog })))
export const AIWorkspace = lazy(() => import('../ai-workspace/AIWorkspace').then((module) => ({ default: module.AIWorkspace })))

import { Books, ChartLineUp, ChatCircleDots, Cpu, FlowArrow, GearSix, Play, PlugsConnected, Robot, Sparkle, Wrench, type Icon } from '@phosphor-icons/react'
import type { Page } from './store'

export const NAV: { page: Page; label: string; icon: Icon }[] = [
  { page: 'dashboard', label: 'Dashboard', icon: ChartLineUp },
  { page: 'chat', label: 'Chat', icon: ChatCircleDots },
  { page: 'knowledge', label: 'Knowledge', icon: Books },
  { page: 'skills', label: 'Skills', icon: Sparkle },
  { page: 'agents', label: 'Agents', icon: Robot },
  { page: 'tools', label: 'Tools', icon: Wrench },
  { page: 'workflows', label: 'Flows', icon: FlowArrow },
  { page: 'providers', label: 'Models', icon: Cpu },
  { page: 'run', label: 'Run', icon: Play },
  { page: 'mcp', label: 'MCP', icon: PlugsConnected },
  { page: 'settings', label: 'Settings', icon: GearSix }
]

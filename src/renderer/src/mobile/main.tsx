// The bridge must be installed before anything reads window.cloth.
import './install'
import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles.css'
import { App } from '../App'
import { Logo } from '../components/Logo'
import { initConnection, useConnection } from './bridge'
import { Connect } from './Connect'
import { styleSystemBars } from './native'

function Root() {
  const pairing = useConnection((s) => s.pairing)
  const state = useConnection((s) => s.state)
  useEffect(() => {
    void initConnection()
    void styleSystemBars()
    // Folding, unfolding or rotating can reset the bars to the system's light/dark default.
    let t: ReturnType<typeof setTimeout> | undefined
    const restyle = () => {
      clearTimeout(t)
      t = setTimeout(() => void styleSystemBars(), 250)
    }
    window.addEventListener('resize', restyle)
    return () => {
      clearTimeout(t)
      window.removeEventListener('resize', restyle)
    }
  }, [])
  if (state === 'loading')
    return (
      <div className="flex h-full items-center justify-center">
        <Logo size={44} />
      </div>
    )
  if (!pairing || state === 'unpaired' || state === 'unconfigured') return <Connect />
  return <App />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>
)

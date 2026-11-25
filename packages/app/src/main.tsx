import { createRoot } from 'react-dom/client'
import { App } from './ui/App'
import './ui/styles.css'

createRoot(document.getElementById('root')!).render(<App />)

// Development builds expose the Linux machine for tests and debugging.
if (import.meta.env.DEV) import('./machine/machine').then(({ machine }) => ((window as any).bhMachine = machine))

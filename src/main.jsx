import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import PokerApp from './PokerApp.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <PokerApp />
  </StrictMode>,
)

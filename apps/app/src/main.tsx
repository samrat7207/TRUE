import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { ControlRoom } from './control/ControlRoom.tsx';
import { isNativeApp } from './server.ts';

// The Control Room is shown only on the laptop itself: the page was opened from localhost, in a wide window,
// not inside a frame, not in the Android app, and not with ?view=phone. Everything else gets the phone app.
function wantsControlRoom(): boolean {
  return ['localhost', '127.0.0.1'].includes(window.location.hostname)
    && window.innerWidth >= 1100
    && window.self === window.top
    && !isNativeApp
    && new URLSearchParams(window.location.search).get('view') !== 'phone';
}

function Root() {
  const [controlRoom, setControlRoom] = useState(wantsControlRoom);
  useEffect(() => {
    const onResize = () => setControlRoom(wantsControlRoom());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return controlRoom ? <ControlRoom /> : <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

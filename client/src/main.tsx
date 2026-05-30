import 'bootstrap/dist/css/bootstrap.min.css';
import './index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Home from './pages/Home.tsx';
import Admin from './pages/Admin.tsx';
import Player from './pages/Player.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/admin/:roomId" element={<Admin />} />
        <Route path="/r/:roomId" element={<Player />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);

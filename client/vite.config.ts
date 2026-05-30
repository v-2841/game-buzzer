import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, Vite serves the UI and proxies the Socket.IO connection to the
// Node server, so the client always talks to the same origin (works from a
// phone on the LAN too). In prod the Node server serves the built client.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // listen on 0.0.0.0 so phones on the LAN can reach it
    port: 5173,
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});

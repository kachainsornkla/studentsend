import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'StudentSend',
        short_name: 'StudentSend',
        description: 'ระบบจัดการและรับส่งงานนักเรียนด้วย QR Code',
        theme_color: '#087f77',
        background_color: '#f5f8f8',
        display: 'standalone',
        start_url: '/',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/@supabase/')) return 'supabase'
          if (id.includes('node_modules/html5-qrcode/')) return 'scanner'
          if (id.includes('node_modules/qrcode.react/')) return 'qrcode'
          if (id.includes('node_modules/react-dom/') || id.includes('node_modules/react/')) return 'react'
        },
      },
    },
  },
})

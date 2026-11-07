import { defineConfig } from 'vite';

// 빌드 결과는 정적 파일 묶음(아트팩트·자체 도메인·미니앱 웹뷰에 그대로 올릴 수 있게 상대 경로, 고정 파일명).
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    target: 'es2020',
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/game.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  server: { host: true },
});

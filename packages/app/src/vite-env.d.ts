/// <reference types="vite/client" />
declare const __BUILD__: string
declare module 'virtual:pwa-register' {
  export function registerSW(o?: any): any
}

import { WoxImage } from "@wox-launcher/wox-plugin"

const icon = (path: string, background = "#7454d6"): WoxImage => ({
  ImageType: "svg",
  ImageData: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="${background}"/><path d="${path}" fill="none" stroke="white" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
})

export const PASSWORD_ICON = icon("M29 18a8 8 0 1 0-6.2 7.8L26 29h5v5h5v-5l-7-7M15 18h.1")
export const COPY_ICON = icon("M18 15h16v20H18zM14 31h-2V11h16v2", "#3867d6")
export const USER_ICON = icon("M24 24a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm-12 14c1-7 5-10 12-10s11 3 12 10", "#2d98da")
export const DETAIL_ICON = icon(
  "M7 24s6-10 17-10 17 10 17 10-6 10-17 10S7 24 7 24Zm17 4a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  "#20bf6b"
)
export const EDIT_ICON = icon("M11 35l2-8L30 10l8 8-17 17-8 2 2-8m12-16 8 8", "#f7b731")
export const UNLOCK_ICON = icon("M14 22v-5a10 10 0 0 1 18-6M12 22h24v18H12z", "#eb3b5a")
export const CONNECT_ICON = icon("M17 15v-4m14 4v-4M14 15h20v7a10 10 0 0 1-20 0zM24 32v6", "#20bf6b")
export const DISCONNECT_ICON = icon("M17 15v-4m14 4v-4M14 15h20v5M13 35l22-22", "#eb3b5a")

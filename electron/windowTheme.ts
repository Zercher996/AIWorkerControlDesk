export const windowThemeOverlay = {
  dark: {
    color: '#171d29',
    symbolColor: '#8490a6'
  },
  light: {
    color: '#e9eef5',
    symbolColor: '#40506a'
  }
} as const

export type WindowTheme = keyof typeof windowThemeOverlay

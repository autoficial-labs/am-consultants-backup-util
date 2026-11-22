import { webDarkTheme, webLightTheme, type Theme } from '@fluentui/react-components';

// Windows 11's own UI face first; Fluent's stack as fallback (macOS gets San Francisco).
const fontFamilyBase =
  "'Segoe UI Variable Text', 'Segoe UI Variable', 'Segoe UI', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif";

export const lightTheme: Theme = { ...webLightTheme, fontFamilyBase };
export const darkTheme: Theme = { ...webDarkTheme, fontFamilyBase };

/** Restore-comparison colours, validated for colour-vision deficiency in both modes. Always paired with an icon and a label. */
export const diffColors = {
  light: { restore: '#107C10', overwrite: '#0F6CBD', extra: '#C50F1F', same: '#C8C6C4' },
  dark: { restore: '#3D9A3D', overwrite: '#2886DE', extra: '#D6595D', same: '#525252' },
};

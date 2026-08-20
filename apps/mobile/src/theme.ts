export const colors = {
  background: "#F5F6FA",
  surface: "#FFFFFF",
  surfaceMuted: "#F0F1F5",
  border: "#E2E4EB",
  text: "#171923",
  textMuted: "#747987",
  textSoft: "#989CA8",
  primary: "#5B5EE8",
  primarySoft: "#EEEFFF",
  ink: "#1B1E2B",
  success: "#22A06B",
  warning: "#E7A33E",
  danger: "#D65347",
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28 } as const;
export const radius = { sm: 8, md: 12, lg: 16, xl: 22, pill: 999 } as const;

export const shadows = {
  card: {
    shadowColor: "#171923",
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.055,
    shadowRadius: 14,
    elevation: 2,
  },
} as const;

import { createTheme } from "@mui/material/styles";

export const browserCrewTheme = createTheme({
  cssVariables: true,
  shape: { borderRadius: 12 },
  typography: {
    fontFamily: '"Inter", system-ui, sans-serif',
    h1: { fontFamily: '"Poppins", system-ui, sans-serif', fontWeight: 600 },
    h2: { fontFamily: '"Poppins", system-ui, sans-serif', fontWeight: 600 },
    h3: { fontFamily: '"Poppins", system-ui, sans-serif', fontWeight: 600 },
    h4: { fontFamily: '"Poppins", system-ui, sans-serif', fontWeight: 600 },
    h5: { fontFamily: '"Poppins", system-ui, sans-serif', fontWeight: 600 },
    h6: { fontFamily: '"Poppins", system-ui, sans-serif', fontWeight: 600 },
    button: { textTransform: "none", fontWeight: 600 }
  },
  components: {
    MuiButton: { defaultProps: { disableElevation: true } },
    MuiTooltip: { defaultProps: { arrow: true } }
  }
});

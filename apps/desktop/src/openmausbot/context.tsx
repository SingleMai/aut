import { createContext, useContext } from "react";

// aut owns the view preference; upstream components only read its value.
const AdvancedModeContext = createContext(false);
export const AdvancedModeProvider = AdvancedModeContext.Provider;
export const useAdvancedMode = () => useContext(AdvancedModeContext);

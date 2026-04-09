import { createContext } from "react";

export type OnboardingStep = 'welcome' | 'connect' | 'create-account';

export interface OnboardingPreferences {
  countries: string[];
  currencies: string[];
}

export interface OnboardingContextType {
  currentStep: OnboardingStep;
  setCurrentStep: (step: OnboardingStep) => void;
  preferences: OnboardingPreferences;
  setCountries: (countries: string[]) => void;
  setCurrencies: (currencies: string[]) => void;
  resetPreferences: () => void;
}

export const defaultPreferences: OnboardingPreferences = {
  countries: [],
  currencies: [],
};

export const OnboardingContext = createContext<OnboardingContextType | undefined>(undefined);

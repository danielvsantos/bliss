import { createContext, useContext, useState, ReactNode } from "react";

type OnboardingStep = 'welcome' | 'connect' | 'create-account';

interface OnboardingPreferences {
  countries: string[];
  currencies: string[];
}

interface OnboardingContextType {
  currentStep: OnboardingStep;
  setCurrentStep: (step: OnboardingStep) => void;
  preferences: OnboardingPreferences;
  setCountries: (countries: string[]) => void;
  setCurrencies: (currencies: string[]) => void;
  resetPreferences: () => void;
}

const defaultPreferences: OnboardingPreferences = {
  countries: [],
  currencies: [],
};

const OnboardingContext = createContext<OnboardingContextType | undefined>(undefined);

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const [currentStep, setCurrentStep] = useState<OnboardingStep>('welcome');
  const [preferences, setPreferences] = useState<OnboardingPreferences>(defaultPreferences);

  const setCountries = (countries: string[]) => {
    setPreferences(prev => ({ ...prev, countries }));
  };

  const setCurrencies = (currencies: string[]) => {
    setPreferences(prev => ({ ...prev, currencies }));
  };

  const resetPreferences = () => {
    setPreferences(defaultPreferences);
    setCurrentStep('welcome');
  };

  return (
    <OnboardingContext.Provider
      value={{
        currentStep,
        setCurrentStep,
        preferences,
        setCountries,
        setCurrencies,
        resetPreferences,
      }}
    >
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboarding() {
  const context = useContext(OnboardingContext);
  if (context === undefined) {
    throw new Error("useOnboarding must be used within an OnboardingProvider");
  }
  return context;
}

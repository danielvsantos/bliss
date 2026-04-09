import { useState, ReactNode } from "react";
import {
  OnboardingContext,
  OnboardingStep,
  OnboardingPreferences,
  defaultPreferences,
} from "./onboarding-context-value";

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

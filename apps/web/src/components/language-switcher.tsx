import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Globe } from 'lucide-react';

const languages = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  // Add more languages as needed
];

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  const [currentLanguage, setCurrentLanguage] = useState(i18n.language.split('-')[0]);

  useEffect(() => {
    const languageCode = i18n.language.split('-')[0]; // Get base language code (e.g., 'en' from 'en-US')
    setCurrentLanguage(languageCode);
  }, [i18n.language]);
  
  // Check for saved language preference on component mount
  useEffect(() => {
    const savedLanguage = localStorage.getItem('i18nextLng');
    if (savedLanguage && languages.some(lang => lang.code === savedLanguage)) {
      i18n.changeLanguage(savedLanguage);
      setCurrentLanguage(savedLanguage);
    }
  }, [i18n]);

  const changeLanguage = (languageCode: string) => {
    i18n.changeLanguage(languageCode);
    setCurrentLanguage(languageCode);
    // Store language preference in localStorage
    localStorage.setItem('i18nextLng', languageCode);
  };

  return (
    <Select value={currentLanguage} onValueChange={changeLanguage}>
      <SelectTrigger className="w-[140px] border-none bg-transparent hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md">
        <SelectValue placeholder={t('pages.settings.language')}>
          <div className="flex items-center">
            <Globe className="h-4 w-4 mr-2" />
            {languages.find(lang => lang.code === currentLanguage)?.name || t('pages.settings.language')}
          </div>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {languages.map((language) => (
          <SelectItem key={language.code} value={language.code}>
            {language.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
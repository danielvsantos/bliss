import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Sparkles, ArrowLeft } from "lucide-react";

interface ComingSoonProps {
  /** Optional override for the page title shown in the card */
  featureName?: string;
}

export default function ComingSoonPage({ featureName }: ComingSoonProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-center min-h-[60vh] p-6">
      <Card className="w-full max-w-md text-center">
        <CardHeader className="pb-4">
          <div className="flex justify-center mb-4">
            <div className="h-16 w-16 rounded-full bg-muted flex items-center justify-center">
              <Sparkles className="h-8 w-8 text-primary" />
            </div>
          </div>
          <CardTitle className="text-2xl">
            {featureName || t('pages.comingSoon.title')}
          </CardTitle>
          <CardDescription className="text-base mt-2">
            {t('pages.comingSoon.subtitle')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('pages.comingSoon.description')}
          </p>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => navigate('/')}
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('pages.comingSoon.backToHome')}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

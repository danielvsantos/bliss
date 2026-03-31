import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { 
  Card, 
  CardContent, 
  CardDescription, 
  CardHeader, 
  CardTitle 
} from "@/components/ui/card";
import { 
  LineChart, 
  PieChart, 
  Briefcase,
  ArrowRight
} from "lucide-react";

export default function ReportsOverviewPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const reportOptions = [
    {
      id: 1,
      title: t("pages.reports.pnl.title"),
      description: t("pages.reports.pnl.description"),
      icon: <LineChart className="h-8 w-8 text-primary" />,
      path: "/reports/pnl",
    },
    {
      id: 2,
      title: t("pages.reports.expenses.title"),
      description: t("pages.reports.expenses.description"),
      icon: <PieChart className="h-8 w-8 text-primary" />,
      path: "/reports/expenses",
    },
    {
      id: 3,
      title: t("pages.portfolio.title"),
      description: t("pages.portfolio.description"),
      icon: <Briefcase className="h-8 w-8 text-primary" />,
      path: "/reports/portfolio",
    },
  ];

  return (
    <div className="container mx-auto py-6">
      <div className="flex flex-col space-y-8">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">{t("pages.reports.title")}</h2>
          <p className="text-muted-foreground mt-2">
            {t("pages.reports.subtitle")}
          </p>
        </div>

        <div className="grid gap-6 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
          {reportOptions.map((report) => (
            <Card 
              key={report.id} 
              className="transition-all hover:shadow-md cursor-pointer"
              onClick={() => navigate(report.path)}
            >
              <CardHeader>
                <div className="flex items-center gap-4">
                  {report.icon}
                  <CardTitle>{report.title}</CardTitle>
                </div>
                <CardDescription>{report.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <Button className="w-full">
                  {t("common.viewReport")}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card className="mt-8">
          <CardHeader>
            <CardTitle>{t("pages.reports.recentReports.title")}</CardTitle>
            <CardDescription>
              {t("pages.reports.recentReports.description")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-center p-6 text-muted-foreground">
              <p>{t("pages.reports.recentReports.empty")}</p>
              <p className="text-sm">{t("pages.reports.recentReports.hint")}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
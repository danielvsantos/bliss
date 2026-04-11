import * as React from "react";
import { SlidersHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useIsMobile } from "@/hooks/use-mobile";
import { Button } from "./button";
import { Badge } from "./badge";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "./drawer";

interface MobileFilterDrawerProps {
  children: React.ReactNode;
  activeFilterCount?: number;
}

export function MobileFilterDrawer({
  children,
  activeFilterCount = 0,
}: MobileFilterDrawerProps) {
  const isMobile = useIsMobile();
  const { t } = useTranslation();

  if (!isMobile) {
    return <>{children}</>;
  }

  return (
    <Drawer>
      <DrawerTrigger asChild>
        <Button variant="outline" className="w-full justify-center gap-2">
          <SlidersHorizontal className="h-4 w-4" />
          {t("common.filter")}
          {activeFilterCount > 0 && (
            <Badge className="h-5 min-w-5 px-1.5 text-xs bg-primary text-primary-foreground">
              {activeFilterCount}
            </Badge>
          )}
        </Button>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t("common.filter")}</DrawerTitle>
        </DrawerHeader>
        <div className="px-4 pb-4 space-y-4 overflow-y-auto">
          {children}
        </div>
        <DrawerFooter>
          <DrawerClose asChild>
            <Button className="w-full">{t("common.apply")}</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

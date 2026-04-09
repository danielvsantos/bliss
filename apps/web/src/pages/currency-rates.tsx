import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppShell } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { RefreshCw, Plus, Pencil, Trash2 } from "lucide-react";
import { formatDate } from "@/lib/utils";
import api from "@/lib/api";
import { getTenantMeta } from "@/utils/tenantMetaStorage";

// Modal UI
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogFooter } from "@/components/ui/alert-dialog";

interface CurrencyRate {
  id: number;
  currencyFrom: string;
  currencyTo: string;
  value: number;
  year: number;
  month: number;
  day: number;
  provider?: string;
  updatedAt?: string;
}

export default function CurrencyRatesPage() {
  const { t } = useTranslation();
  const [currencyRates, setCurrencyRates] = useState<CurrencyRate[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [addForm, setAddForm] = useState({
    currencyFrom: "",
    currencyTo: "",
    value: "",
    year: new Date().getFullYear(),
    month: new Date().getMonth() + 1,
    day: new Date().getDate(),
    provider: "",
  });
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Get available currencies from tenant meta
  const tenantMeta = getTenantMeta();
  const availableCurrencies = tenantMeta?.currencies || [];

  // Fetch rates
  const fetchRates = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getCurrencyRates();
      setCurrencyRates(Array.isArray(data) ? data : []);
    } catch (e: unknown) {
      setError((e as { message?: string })?.message || "Failed to load currency rates");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRates();
  }, []);

  // Filtered rates
  const filteredRates = currencyRates.filter((rate) => {
    const from = rate.currencyFrom?.toLowerCase() || "";
    const to = rate.currencyTo?.toLowerCase() || "";
    const provider = rate.provider?.toLowerCase() || "";
    const search = searchTerm.toLowerCase();
    return (
      from.includes(search) ||
      to.includes(search) ||
      provider.includes(search)
    );
  });

  // Add or Edit rate
  const handleSaveRate = async () => {
    setAddLoading(true);
    setAddError(null);
    try {
      const { currencyFrom, currencyTo, value, year, month, day, provider } = addForm;
      if (!currencyFrom || !currencyTo || !value || !year || !month || !day) {
        setAddError("All fields are required");
        setAddLoading(false);
        return;
      }
      if (editMode && editId !== null) {
        // Edit mode
        await api.updateCurrencyRate(editId, {
          year: Number(year),
          month: Number(month),
          day: Number(day),
          currencyFrom,
          currencyTo,
          value: value,
          provider: provider || undefined,
        });
      } else {
        // Add mode
        await api.createOrUpdateCurrencyRate({
          currencyFrom,
          currencyTo,
          value: value,
          year: Number(year),
          month: Number(month),
          day: Number(day),
          provider: provider || undefined,
        });
      }
      setShowAddModal(false);
      setAddForm({
        currencyFrom: "",
        currencyTo: "",
        value: "",
        year: new Date().getFullYear(),
        month: new Date().getMonth() + 1,
        day: new Date().getDate(),
        provider: "",
      });
      setEditMode(false);
      setEditId(null);
      fetchRates();
    } catch (e: unknown) {
      const errorObj = e as { response?: { data?: { error?: string } }, message?: string };
      setAddError(errorObj?.response?.data?.error || errorObj?.message || "Failed to save rate");
    } finally {
      setAddLoading(false);
    }
  };

  // Open edit modal with pre-filled values
  const handleEdit = (rate: CurrencyRate) => {
    setAddForm({
      currencyFrom: rate.currencyFrom,
      currencyTo: rate.currencyTo,
      value: rate.value.toString(),
      year: rate.year,
      month: rate.month,
      day: rate.day,
      provider: rate.provider || "",
    });
    setEditMode(true);
    setEditId(rate.id);
    setShowAddModal(true);
    setAddError(null);
  };

  // Delete rate
  const handleDelete = async () => {
    if (deleteId == null) return;
    setDeleteLoading(true);
    setDeleteError(null);
    try {
      await api.deleteCurrencyRate(deleteId);
      setShowDeleteDialog(false);
      setDeleteId(null);
      fetchRates();
    } catch (e: unknown) {
      const errorObj = e as { response?: { data?: { error?: string } }, message?: string };
      setDeleteError(errorObj?.response?.data?.error || errorObj?.message || "Failed to delete rate");
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <div className="container mx-auto py-6">
      <div className="flex flex-col space-y-8">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>{t('currencyRates.title')}</CardTitle>
                <CardDescription>
                  {t('currencyRates.subtitle')}
                </CardDescription>
              </div>
              <div className="flex items-center space-x-2">
                <Button variant="outline" size="sm" onClick={fetchRates} disabled={loading}>
                  <RefreshCw className={"mr-2 h-4 w-4 " + (loading ? "animate-spin" : "")} />
                  {t('currencyRates.refreshRates')}
                </Button>
                <Button size="sm" onClick={() => {
                  setShowAddModal(true);
                  setEditMode(false);
                  setEditId(null);
                  setAddForm({
                    currencyFrom: "",
                    currencyTo: "",
                    value: "",
                    year: new Date().getFullYear(),
                    month: new Date().getMonth() + 1,
                    day: new Date().getDate(),
                    provider: "",
                  });
                  setAddError(null);
                }}>
                  <Plus className="mr-2 h-4 w-4" />
                  {t('currencyRates.addRate')}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <Input
                placeholder={t('currencyRates.searchPlaceholder')}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="max-w-sm"
              />
              {error && <span className="text-destructive text-sm">{error}</span>}
            </div>
            <div className="rounded-md border min-h-[200px]">
              {loading ? (
                <div className="flex items-center justify-center py-12">{t('common.loading')}</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('currencyRates.from')}</TableHead>
                      <TableHead>{t('currencyRates.to')}</TableHead>
                      <TableHead>{t('currencyRates.rate')}</TableHead>
                      <TableHead>{t('currencyRates.year')}</TableHead>
                      <TableHead>{t('currencyRates.month')}</TableHead>
                      <TableHead>{t('currencyRates.day')}</TableHead>
                      <TableHead>{t('currencyRates.provider')}</TableHead>
                      <TableHead>{t('currencyRates.lastUpdated')}</TableHead>
                      <TableHead className="text-right">{t('common.actions')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredRates.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center text-muted-foreground">{t('currencyRates.noRatesFound')}</TableCell>
                      </TableRow>
                    ) : (
                      filteredRates.map((rate) => (
                        <TableRow key={rate.id}>
                          <TableCell className="font-medium">{rate.currencyFrom}</TableCell>
                          <TableCell>{rate.currencyTo}</TableCell>
                          <TableCell>{rate.value?.toFixed(4)}</TableCell>
                          <TableCell>{rate.year}</TableCell>
                          <TableCell>{rate.month}</TableCell>
                          <TableCell>{rate.day}</TableCell>
                          <TableCell>{rate.provider || "-"}</TableCell>
                          <TableCell>{rate.updatedAt ? formatDate(rate.updatedAt) : "-"}</TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-2">
                              <Button variant="ghost" size="icon" disabled>
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button variant="ghost" size="icon" disabled>
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Add Rate Modal */}
      <Dialog open={showAddModal} onOpenChange={setShowAddModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('currencyRates.addTitle')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex gap-2">
              <Select
                value={addForm.currencyFrom}
                onValueChange={(v) => setAddForm((f) => ({ ...f, currencyFrom: v }))}
              >
                <SelectTrigger className="w-32">
                  <SelectValue placeholder={t('currencyRates.from')} />
                </SelectTrigger>
                <SelectContent>
                  {availableCurrencies.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.symbol ? `${c.symbol} ` : ''}{c.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={addForm.currencyTo}
                onValueChange={(v) => setAddForm((f) => ({ ...f, currencyTo: v }))}
              >
                <SelectTrigger className="w-32">
                  <SelectValue placeholder={t('currencyRates.to')} />
                </SelectTrigger>
                <SelectContent>
                  {availableCurrencies.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.symbol ? `${c.symbol} ` : ''}{c.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Input
              type="text"
              placeholder={t('currencyRates.providerOptional')}
              value={addForm.provider}
              onChange={(e) => setAddForm((f) => ({ ...f, provider: e.target.value }))}
            />
            <Input
              type="number"
              step="0.0001"
              min="0"
              placeholder={t('currencyRates.rate')}
              value={addForm.value}
              onChange={(e) => setAddForm((f) => ({ ...f, value: e.target.value }))}
            />
            <div className="flex gap-2">
              <Input
                type="number"
                min="2000"
                max="2100"
                placeholder={t('currencyRates.year')}
                value={addForm.year}
                onChange={(e) => setAddForm((f) => ({ ...f, year: Number(e.target.value) }))}
                className="w-24"
              />
              <Input
                type="number"
                min="1"
                max="12"
                placeholder={t('currencyRates.month')}
                value={addForm.month}
                onChange={(e) => setAddForm((f) => ({ ...f, month: Number(e.target.value) }))}
                className="w-20"
              />
              <Input
                type="number"
                min="1"
                max="31"
                placeholder={t('currencyRates.day')}
                value={addForm.day}
                onChange={(e) => setAddForm((f) => ({ ...f, day: Number(e.target.value) }))}
                className="w-20"
              />
            </div>
            {addError && <span className="text-destructive text-sm">{addError}</span>}
          </div>
          <DialogFooter>
            <Button onClick={handleSaveRate} disabled={addLoading}>
              {addLoading ? (
                <span className="flex items-center gap-2">
                  <RefreshCw className="h-4 w-4 animate-spin" /> {t('currencyRates.adding')}
                </span>
              ) : (
                t('currencyRates.addRate')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
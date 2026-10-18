import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, FileKey, Upload, XCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { checkPrivateKey, MAX_PRIVATE_KEY_BYTES, type PemErrorCode } from '@/lib/pem';

const T = 'enableBanking.keyInput';

interface EnableBankingKeyInputProps {
  /** The PEM text. Held by the parent form only, cleared after a save. */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** A server-side format error (KEY_* code) for the current value. */
  serverError?: PemErrorCode | null;
}

/**
 * Private-key input for Enable Banking credentials (#148, R1a): a `.pem`
 * upload (primary) or a multi-line paste area, with an instant browser check.
 * The file is read with FileReader and only its text is kept, in the parent's
 * state — never in browser storage. The file input is reset after each read.
 */
export function EnableBankingKeyInput({ value, onChange, disabled, serverError }: EnableBankingKeyInputProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'upload' | 'paste'>('upload');
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileError, setFileError] = useState<PemErrorCode | 'READ_FAILED' | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // The parent clears the value after a save: drop what we know about the file too.
  useEffect(() => {
    if (!value) setFileName(null);
  }, [value]);

  const check = value ? checkPrivateKey(value) : null;
  const errorCode: PemErrorCode | 'READ_FAILED' | null = fileError
    ?? (check && !check.ok ? check.code : null)
    ?? serverError
    ?? null;

  const readFile = (file: File | undefined) => {
    if (!file) return;
    setFileError(null);
    setFileName(file.name);
    if (file.size > MAX_PRIVATE_KEY_BYTES) {
      onChange('');
      setFileError('KEY_TOO_LARGE');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => onChange(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => {
      onChange('');
      setFileError('READ_FAILED');
    };
    reader.readAsText(file);
  };

  const clear = () => {
    onChange('');
    setFileName(null);
    setFileError(null);
  };

  const switchMode = (next: 'upload' | 'paste') => {
    clear();
    setMode(next);
  };

  return (
    <div className="space-y-2">
      <Label htmlFor={mode === 'paste' ? 'eb-private-key' : undefined}>{t('enableBanking.credentials.keyLabel')}</Label>

      {mode === 'upload' ? (
        <div
          data-testid="eb-key-dropzone"
          onDragOver={(e) => {
            e.preventDefault();
            if (!disabled) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (!disabled) readFile(e.dataTransfer.files?.[0]);
          }}
          className={cn(
            'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-5 text-center',
            dragging ? 'border-brand-primary bg-brand-primary/5' : 'border-border',
          )}
        >
          <FileKey className="h-6 w-6 text-muted-foreground" />
          {fileName ? (
            <p className="text-sm font-medium break-all" data-testid="eb-key-filename">{fileName}</p>
          ) : (
            <p className="text-sm text-muted-foreground">{t(`${T}.drop`)}</p>
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()} disabled={disabled}>
              <Upload className="h-3.5 w-3.5 mr-2" />
              {t(`${T}.choose`)}
            </Button>
            {fileName && (
              <Button type="button" variant="ghost" size="sm" onClick={clear} disabled={disabled}>
                {t(`${T}.clear`)}
              </Button>
            )}
          </div>
          <input
            ref={fileInput}
            type="file"
            accept=".pem,.key,.txt"
            className="hidden"
            data-testid="eb-key-file"
            disabled={disabled}
            onChange={(e) => {
              readFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
      ) : (
        <Textarea
          id="eb-private-key"
          aria-label={t(`${T}.pasteLabel`)}
          data-testid="eb-key-textarea"
          rows={8}
          value={value}
          onChange={(e) => {
            setFileError(null);
            onChange(e.target.value);
          }}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          placeholder={'-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----'}
          className="font-mono text-xs resize-y max-h-72 overflow-auto"
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 min-h-5">
        <div aria-live="polite" data-testid="eb-key-result">
          {errorCode ? (
            <p className="flex items-center gap-1.5 text-xs text-destructive">
              <XCircle className="h-3.5 w-3.5 shrink-0" />
              {errorCode === 'READ_FAILED' ? t(`${T}.readFailed`) : t(`${T}.error${errorCode}`)}
            </p>
          ) : check?.ok ? (
            <p className="flex items-center gap-1.5 text-xs text-positive">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              {t(`${T}.valid`, { bits: check.bits })}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
          onClick={() => switchMode(mode === 'upload' ? 'paste' : 'upload')}
          disabled={disabled}
        >
          {mode === 'upload' ? t(`${T}.pasteInstead`) : t(`${T}.uploadInstead`)}
        </Button>
      </div>
    </div>
  );
}

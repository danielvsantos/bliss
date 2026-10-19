/**
 * Private-key input (#148, R1a): upload and paste paths, the instant check,
 * no network call and no browser storage.
 */
import React, { useState } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { EnableBankingKeyInput } from './enable-banking-key-input';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => (opts ? `${k} ${JSON.stringify(opts)}` : k),
    i18n: { language: 'en' },
  }),
}));

const KEYS_DIR = join(__dirname, '../../../../../packages/shared/test-fixtures/enablebanking-keys');
const read = (name: string) => readFileSync(join(KEYS_DIR, name), 'utf8');
const T = 'enableBanking.keyInput';

function Harness({ onValue }: { onValue?: (v: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <>
      <EnableBankingKeyInput
        value={value}
        onChange={(v) => {
          setValue(v);
          onValue?.(v);
        }}
      />
      <button type="button" onClick={() => setValue('')}>reset</button>
    </>
  );
}

const pemFile = (name: string, content: string) => new File([content], name, { type: 'application/x-pem-file' });

describe('EnableBankingKeyInput', () => {
  it('reads an uploaded .pem and shows "Valid RSA private key · N-bit"', async () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    const input = screen.getByTestId('eb-key-file') as HTMLInputElement;
    expect(input.accept).toBe('.pem,.key,.txt');
    fireEvent.change(input, { target: { files: [pemFile('bliss.pem', read('rsa4096-pkcs8.pem'))] } });

    await waitFor(() => expect(screen.getByTestId('eb-key-result')).toHaveTextContent(`${T}.valid {"bits":4096}`));
    expect(screen.getByTestId('eb-key-filename')).toHaveTextContent('bliss.pem');
    expect(onValue).toHaveBeenLastCalledWith(read('rsa4096-pkcs8.pem'));
    expect(input.value).toBe(''); // the file input is reset after reading
  });

  it('accepts a dropped file', async () => {
    render(<Harness />);
    fireEvent.drop(screen.getByTestId('eb-key-dropzone'), { dataTransfer: { files: [pemFile('k.pem', read('rsa2048-pkcs1.pem'))] } });
    await waitFor(() => expect(screen.getByTestId('eb-key-result')).toHaveTextContent(`${T}.valid {"bits":2048}`));
  });

  it('rejects a file over 16 KB without reading it', async () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    fireEvent.change(screen.getByTestId('eb-key-file'), { target: { files: [pemFile('big.pem', read('oversize.pem'))] } });
    expect(screen.getByTestId('eb-key-result')).toHaveTextContent(`${T}.errorKEY_TOO_LARGE`);
    expect(onValue).toHaveBeenLastCalledWith('');
  });

  it.each([
    ['truncated.pem', 'KEY_TRUNCATED'],
    ['public.pem', 'KEY_PUBLIC'],
    ['certificate.pem', 'KEY_CERTIFICATE'],
    ['encrypted-pkcs8.pem', 'KEY_ENCRYPTED'],
    ['ec-pkcs8.pem', 'KEY_NOT_RSA'],
    ['not-pem.txt', 'KEY_NOT_PEM'],
  ])('shows the specific error for a pasted %s', (file, code) => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: `${T}.pasteInstead` }));
    fireEvent.change(screen.getByTestId('eb-key-textarea'), { target: { value: read(file) } });
    expect(screen.getByTestId('eb-key-result')).toHaveTextContent(`${T}.error${code}`);
  });

  it.each(['rsa4096-pkcs8.pem', 'rsa4096-crlf.pem', 'rsa4096-escaped.txt'])('accepts %s pasted', (file) => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: `${T}.pasteInstead` }));
    fireEvent.change(screen.getByTestId('eb-key-textarea'), { target: { value: read(file) } });
    expect(screen.getByTestId('eb-key-result')).toHaveTextContent(`${T}.valid {"bits":4096}`);
  });

  it('is a multi-line monospace area with spell-check, autocorrect and autocomplete off', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: `${T}.pasteInstead` }));
    const area = screen.getByTestId('eb-key-textarea');
    expect(area.tagName).toBe('TEXTAREA');
    expect(area).toHaveAttribute('rows', '8');
    expect(area).toHaveAttribute('spellcheck', 'false');
    expect(area).toHaveAttribute('autocomplete', 'off');
    expect(area).toHaveAttribute('autocorrect', 'off');
    expect(area).toHaveAttribute('autocapitalize', 'off');
    expect(area.className).toContain('font-mono');
  });

  it('clears the result when the parent resets the value, and never touches browser storage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<Harness />);
    fireEvent.change(screen.getByTestId('eb-key-file'), { target: { files: [pemFile('bliss.pem', read('rsa2048-pkcs8.pem'))] } });
    await waitFor(() => expect(screen.getByTestId('eb-key-result')).toHaveTextContent('enableBanking.keyInput.valid'));
    fireEvent.click(screen.getByRole('button', { name: 'reset' }));
    expect(screen.queryByTestId('eb-key-filename')).not.toBeInTheDocument();
    expect(screen.getByTestId('eb-key-result')).toBeEmptyDOMElement();
    expect(setItem).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    setItem.mockRestore();
    fetchSpy.mockRestore();
  });
});

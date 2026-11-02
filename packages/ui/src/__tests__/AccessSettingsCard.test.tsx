import '@testing-library/jest-dom/vitest';
import '@open-alive/i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AccessSettingsCard } from '../components/AccessSettingsCard.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stub(view: { remoteEnabled: boolean; requireTokenLocally: boolean }) {
  const posts: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as { requireTokenLocally: boolean };
      posts.push(body);
      return { ok: true, status: 200, json: async () => ({ ...view, requireTokenLocally: body.requireTokenLocally }) } as Response;
    }
    return { ok: true, status: 200, json: async () => view } as Response;
  }));
  return posts;
}

describe('AccessSettingsCard', () => {
  it('explains that no token is ever asked locally while remote access is off', async () => {
    stub({ remoteEnabled: false, requireTokenLocally: false });
    render(<AccessSettingsCard active />);
    const box = await screen.findByRole('checkbox');
    expect(box).toBeDisabled();
    expect(screen.getByText(/원격 접속이 꺼져|Remote access is off/)).toBeInTheDocument();
  });

  it('turns the local token requirement off in remote mode and shows the risk', async () => {
    const posts = stub({ remoteEnabled: true, requireTokenLocally: true });
    render(<AccessSettingsCard active />);
    const box = await screen.findByRole('checkbox');
    expect(box).toBeChecked();
    fireEvent.click(box);
    await waitFor(() => expect(posts).toEqual([{ requireTokenLocally: false }]));
    expect(await screen.findByRole('note')).toHaveTextContent(/터널|tunnel/);
  });
});

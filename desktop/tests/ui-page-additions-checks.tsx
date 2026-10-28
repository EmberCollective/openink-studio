import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import assert from 'node:assert/strict';
import App from '../ui/src/App';

export async function run() {
  let saved: any;
  const commands: string[] = [];
  (globalThis as any).__saveMock = async () => '/offline/pages.inkproj';
  (globalThis as any).__invokeMock = async (name: string, args: any) => {
    if (name === 'poll_device' || name.startsWith('list_')) return [];
    if (name === 'default_import_options') return {};
    if (name === 'device_command') {
      commands.push(args.command.type);
    }
    if (name === 'save_project') saved = structuredClone(args.project);
    return null;
  };
  const root = createRoot(document.getElementById('root')!);
  const click = async (label: string) => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === label || b.getAttribute('aria-label') === label || b.title === label);
    assert.ok(button, label);
    await act(async () => button.click());
  };
  try {
    await act(async () => root.render(<App />));
    await click('保存工程');
    const initial = structuredClone(saved.pages[0].document);
    await click('添加页面');
    const copy = [...document.querySelectorAll('.page-add-options button')].find(b => b.textContent?.includes('复制已有页面'))!;
    await act(async () => (copy as HTMLButtonElement).click());
    await click('复制并添加');
    await click('保存工程');
    assert.equal(saved.pages.length, 2, 'Initial empty page can be duplicated');
    assert.deepEqual(saved.pages[1].document.text_settings, initial.text_settings, 'Copy preserves current text settings');
    assert.equal(saved.pages[1].document.strokes.length, 0);
    assert.equal(commands.filter(c => c === 'forget_calibration').length, 0, 'Copy in same layout retains session mapping');
    async function addA4() {
      await click('添加页面');
      const blank = [...document.querySelectorAll('.page-add-options button')].find(b => b.textContent?.includes('空白页面'))!;
      await act(async () => (blank as HTMLButtonElement).click());
      const size = document.querySelector('.page-popover select') as HTMLSelectElement;
      await act(async () => { size.value = 'a4'; size.dispatchEvent(new Event('change', { bubbles: true })); });
      await click('添加空白页');
    }
    await addA4(); await click('保存工程');
    assert.equal(saved.pages.length, 3); assert.equal(saved.current_page, 2);
    assert.equal(saved.pages[2].document.width_mm, 210);
    assert.notEqual(saved.pages[2].layout_id, saved.pages[0].layout_id);
    assert.equal(commands.filter(c => c === 'forget_calibration').length, 0);
    console.log('PASS initial empty copy/text settings and shared origin across added page layouts');
  } finally { await act(async () => root.unmount()); }
}

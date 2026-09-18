import { beforeEach, describe, expect, it } from 'vitest';
import { selectOracleGridValue } from '../src/fill-engine/oracle-select';

describe('selectOracleGridValue', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="editor"></div>';
  });

  it('accepts an exact value committed by an Oracle rerender without waiting for a grid', async () => {
    const editor = document.getElementById('editor')!;
    const initial = document.createElement('input');
    initial.id = 'month-startDate-1';
    initial.setAttribute('role', 'combobox');
    initial.setAttribute('aria-haspopup', 'grid');
    initial.setAttribute('aria-expanded', 'false');
    editor.append(initial);

    initial.addEventListener('click', () => {
      const replacement = document.createElement('input');
      replacement.id = initial.id;
      replacement.value = 'August';
      replacement.setAttribute('role', 'combobox');
      replacement.setAttribute('aria-haspopup', 'grid');
      // This is the stale state observed on the live Oracle form: the value is committed while
      // aria-expanded remains true and no grid is mounted.
      replacement.setAttribute('aria-expanded', 'true');
      initial.replaceWith(replacement);
    });

    const selected = await selectOracleGridValue(
      () => document.getElementById('editor'),
      'input[id^="month-startDate-"]',
      ['August'],
      { pollIntervalMs: 1, maxAttempts: 3 }
    );

    expect(selected).toBe(true);
    expect(editor.querySelector<HTMLInputElement>('input')?.value).toBe('August');
  });

  it('waits for a clicked Oracle grid cell to commit before closing the grid', async () => {
    const editor = document.getElementById('editor')!;
    editor.innerHTML = `
      <input id="month-graduation" role="combobox" aria-controls="month-listbox" aria-expanded="false">
      <div id="month-listbox"></div>`;
    const input = editor.querySelector<HTMLInputElement>('input')!;
    const listbox = editor.querySelector<HTMLElement>('#month-listbox')!;
    input.addEventListener('click', () => {
      input.setAttribute('aria-expanded', 'true');
      listbox.innerHTML = '<div role="gridcell">May</div>';
      listbox.firstElementChild!.addEventListener('click', () => {
        setTimeout(() => {
          input.value = 'May';
          input.setAttribute('aria-expanded', 'false');
        }, 20);
      });
    });

    const selected = await selectOracleGridValue(editor, '#month-graduation', ['May'], {
      pollIntervalMs: 5,
      maxAttempts: 20,
    });

    expect(selected).toBe(true);
    expect(input.value).toBe('May');
    expect(input.dataset.autofillFlag).toBeUndefined();
  });
});

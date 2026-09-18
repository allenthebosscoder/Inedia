// Polyfill CSS.escape for jsdom environment
if (typeof CSS === 'undefined') {
  (globalThis as any).CSS = {
    escape: (str: string) => {
      return String(str).replace(/[\x00-\x1f\x7f-\x9f]/g, (ch) => {
        return '\\' + ch.charCodeAt(0).toString(16) + ' ';
      }).replace(/[!"#$%&'()*+,.\/:;<=>\?@\[\\\]^`\{|\}~]/g, '\\$&');
    },
  };
}

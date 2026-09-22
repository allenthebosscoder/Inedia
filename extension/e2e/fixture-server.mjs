import { createServer } from 'node:http';

const fixture = `<!doctype html>
<html><body>
  <form>
    <label for="first-name">First Name</label><input id="first-name" />
    <section>
      <p>Are you a United States citizen?</p>
      <select id="citizen"><option value="">Select One</option><option value="yes">Yes</option><option value="no">No</option></select>
    </section>
    <section>
      <p>Please provide your minimum salary requirements.</p>
      <textarea id="salary"></textarea>
    </section>
    <section>
      <p>If the position requires, are you able to relocate?</p>
      <select id="relocate"><option value="">Select One</option><option value="yes">Yes</option><option value="no">No</option></select>
    </section>
    <label for="manual">Employer-specific disclosure</label><input id="manual" />
  </form>
</body></html>`;

createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(request.url === '/health' ? 'ok' : fixture);
}).listen(4173, '127.0.0.1');

// Script subprocesses cannot use the flow's MSW: refuse every outside request.
globalThis.fetch = (async () => { throw new Error("Unexpected meteroid-link-org script request"); }) as typeof fetch;

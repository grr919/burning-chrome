import type { VercelRequest, VercelResponse } from '@vercel/node';
import tls from 'node:tls';
import { isIPv4 } from 'node:net';
import dns from 'node:dns/promises';

type HttpsCertificateResponse = {
  provider: 'https_certificate';
  ipAddress: string;
  status: 'ready' | 'error';
  host: string;
  port: number;
  lookupMode?: 'direct_ip' | 'hostname_sni';
  attemptedHosts?: string[];
  statusSummary?: string;
  subjectCn?: string;
  subjectAltNames: string[];
  issuerCn?: string;
  validFrom?: string;
  validTo?: string;
  serialNumber?: string;
  fingerprint256?: string;
  authorized?: boolean;
  authorizationError?: string;
  error?: string;
  warning?: string;
};

function parseSubjectAltNames(subjectAltName?: string): string[] {
  if (!subjectAltName) return [];
  return subjectAltName
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeHostnameCandidates(values: string[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => value.trim().toLowerCase())
        .filter(
          (value) =>
            value.length > 0 &&
            !isIPv4(value) &&
            /^[a-z0-9.-]+$/.test(value) &&
            value.includes('.')
        )
    ),
  ].slice(0, 8);
}

async function reverseDns(ipAddress: string): Promise<string[]> {
  try {
    return await dns.reverse(ipAddress);
  } catch {
    return [];
  }
}

function summarizeTlsFailure(message: string, attemptedHostnameCount: number): string {
  const lower = message.toLowerCase();

  if (lower.includes('timed out')) {
    return attemptedHostnameCount > 0
      ? 'No HTTPS certificate response was received. Direct IP lookup timed out, and hostname-based SNI retries also failed.'
      : 'No HTTPS certificate response was received on port 443.';
  }

  if (lower.includes('handshake failure') || lower.includes('alert number 40')) {
    return attemptedHostnameCount > 0
      ? 'The server rejected a direct IP TLS handshake. Hostname-based SNI retries were also attempted but did not return a certificate.'
      : 'The server rejected a direct IP TLS handshake. This often means the server expects a hostname through SNI.';
  }

  if (lower.includes('certificate') && lower.includes('returned')) {
    return 'The remote host accepted the connection but did not return a usable HTTPS certificate.';
  }

  return attemptedHostnameCount > 0
    ? 'HTTPS certificate lookup failed after both direct IP and hostname-based SNI attempts.'
    : 'HTTPS certificate lookup failed.';
}

function tlsLookupWithOptionalSni(ipAddress: string, servername?: string): Promise<HttpsCertificateResponse> {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (payload: HttpsCertificateResponse) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    const socket = tls.connect(
      {
        host: ipAddress,
        port: 443,
        servername,
        rejectUnauthorized: false,
        timeout: 10000,
      },
      () => {
        try {
          const certificate = socket.getPeerCertificate(true) as any;

          if (!certificate || Object.keys(certificate).length === 0) {
            finish({
              provider: 'https_certificate',
              ipAddress,
              status: 'error',
              host: servername ?? ipAddress,
              port: 443,
              lookupMode: servername ? 'hostname_sni' : 'direct_ip',
              attemptedHosts: [servername ?? ipAddress],
              subjectAltNames: [],
              statusSummary: 'The remote host accepted the connection but did not return a usable HTTPS certificate.',
              error: 'No HTTPS certificate was returned by the remote host.',
            });
            socket.end();
            return;
          }

          finish({
            provider: 'https_certificate',
            ipAddress,
            status: 'ready',
            host: servername ?? ipAddress,
            port: 443,
            lookupMode: servername ? 'hostname_sni' : 'direct_ip',
            attemptedHosts: [servername ?? ipAddress],
            statusSummary: servername
              ? 'Direct IP TLS lookup failed, but a hostname-based SNI retry returned a certificate.'
              : 'HTTPS certificate retrieved successfully using a direct IP lookup.',
            subjectCn: typeof certificate.subject?.CN === 'string' ? certificate.subject.CN : undefined,
            subjectAltNames: parseSubjectAltNames(typeof certificate.subjectaltname === 'string' ? certificate.subjectaltname : undefined),
            issuerCn: typeof certificate.issuer?.CN === 'string' ? certificate.issuer.CN : undefined,
            validFrom: typeof certificate.valid_from === 'string' ? certificate.valid_from : undefined,
            validTo: typeof certificate.valid_to === 'string' ? certificate.valid_to : undefined,
            serialNumber: typeof certificate.serialNumber === 'string' ? certificate.serialNumber : undefined,
            fingerprint256: typeof certificate.fingerprint256 === 'string' ? certificate.fingerprint256 : undefined,
            authorized: socket.authorized,
            authorizationError: socket.authorizationError ?? undefined,
            warning: servername
              ? 'This server appears to respond better when a hostname is provided during TLS negotiation.'
              : undefined,
          });
        } catch (error) {
          finish({
            provider: 'https_certificate',
            ipAddress,
            status: 'error',
            host: servername ?? ipAddress,
            port: 443,
            lookupMode: servername ? 'hostname_sni' : 'direct_ip',
            attemptedHosts: [servername ?? ipAddress],
            subjectAltNames: [],
            statusSummary: 'HTTPS certificate lookup failed during certificate parsing.',
            error: error instanceof Error ? error.message : 'Unknown HTTPS certificate lookup error.',
          });
        } finally {
          socket.end();
        }
      }
    );

    socket.on('error', (error) => {
      finish({
        provider: 'https_certificate',
        ipAddress,
        status: 'error',
        host: servername ?? ipAddress,
        port: 443,
        lookupMode: servername ? 'hostname_sni' : 'direct_ip',
        attemptedHosts: [servername ?? ipAddress],
        subjectAltNames: [],
        statusSummary: summarizeTlsFailure(error instanceof Error ? error.message : String(error), 0),
        error: error instanceof Error ? error.message : 'Unknown TLS connection error.',
      });
    });

    socket.on('timeout', () => {
      finish({
        provider: 'https_certificate',
        ipAddress,
        status: 'error',
        host: servername ?? ipAddress,
        port: 443,
        lookupMode: servername ? 'hostname_sni' : 'direct_ip',
        attemptedHosts: [servername ?? ipAddress],
        subjectAltNames: [],
        statusSummary: summarizeTlsFailure('timed out', 0),
        error: 'HTTPS certificate lookup timed out.',
      });
      socket.destroy();
    });
  });
}

async function lookupHttpsCertificate(ipAddress: string): Promise<HttpsCertificateResponse> {
  const hostnameCandidates = normalizeHostnameCandidates(await reverseDns(ipAddress));
  const directResult = await tlsLookupWithOptionalSni(ipAddress);
  const attemptedHosts = [ipAddress];

  if (directResult.status === 'ready') {
    return { ...directResult, attemptedHosts };
  }

  for (const hostname of hostnameCandidates) {
    const retryResult = await tlsLookupWithOptionalSni(ipAddress, hostname);
    attemptedHosts.push(hostname);

    if (retryResult.status === 'ready') {
      const mergedSans = normalizeHostnameCandidates([
        ...retryResult.subjectAltNames.map((value) => value.replace(/^DNS:/i, '')),
        ...hostnameCandidates,
      ]);

      return {
        ...retryResult,
        attemptedHosts,
        subjectAltNames: mergedSans,
      };
    }
  }

  return {
    ...directResult,
    attemptedHosts,
    statusSummary: summarizeTlsFailure(directResult.error ?? 'HTTPS certificate lookup failed.', hostnameCandidates.length),
    warning: hostnameCandidates.length > 0
      ? `Retried with hostname-based SNI using: ${hostnameCandidates.join(', ')}`
      : directResult.warning,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const ip = typeof req.query.ip === 'string' ? req.query.ip : '';
    if (!isIPv4(ip)) {
      res.status(400).json({ error: 'Please provide a valid IPv4 address.' });
      return;
    }

    const result = await lookupHttpsCertificate(ip);
    res.status(result.status === 'ready' ? 200 : 500).json(result);
  } catch (error) {
    res.status(500).json({
      provider: 'https_certificate',
      ipAddress: '',
      status: 'error',
      host: '',
      port: 443,
      subjectAltNames: [],
      statusSummary: 'Unable to complete HTTPS certificate lookup.',
      error: error instanceof Error ? error.message : String(error),
    } satisfies HttpsCertificateResponse);
  }
}

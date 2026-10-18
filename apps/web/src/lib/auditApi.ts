/**
 * Thin client for the Audit & Alerting Service (services/audit-service).
 * Same flat-wire-shape rationale as consentApi.ts — these types mirror
 * what the service actually returns, not an aspirational domain model.
 */
const BASE_URL = import.meta.env.VITE_AUDIT_SERVICE_URL;

export interface RecordEditEventInput {
  resourceType: string;
  resourceId: string;
  patientId: string;
  action: 'create' | 'update';
  actorId: string;
  actorName: string;
  summary: string;
  originalAuthorId?: string;
  originalAuthorName?: string;
}

export interface NotificationItem {
  id: string;
  read: boolean;
  createdAt: string;
  reason: string;
  resourceType: string;
  resourceId: string;
  patientId: string;
  action: string;
  actorName: string;
  summary: string;
}

async function request<T>(path: string, init?: RequestInit, accessToken?: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? `Audit Service error: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function recordEditEvent(input: RecordEditEventInput): Promise<{ eventId: string; notifiedCount: number }> {
  return request('/events', { method: 'POST', body: JSON.stringify(input) });
}

/**
 * GET /notifications now requires Authorization: Bearer <Medplum access
 * token> (audit-service's caller-identity check, see its README) — a
 * non-admin caller may only read their own recipientId. accessToken comes
 * from the signed-in Medplum session (useMedplum().getAccessToken() at the
 * call site), not stored or managed here.
 */
export function listNotifications(recipientId: string, accessToken: string | undefined, unreadOnly = false): Promise<NotificationItem[]> {
  return request(`/notifications?recipientId=${encodeURIComponent(recipientId)}&unreadOnly=${unreadOnly}`, undefined, accessToken);
}

export function markNotificationRead(id: string): Promise<void> {
  return request(`/notifications/${id}/read`, { method: 'POST' }).then(() => undefined);
}

export function markAllNotificationsRead(recipientId: string): Promise<void> {
  return request('/notifications/read-all', { method: 'POST', body: JSON.stringify({ recipientId }) }).then(() => undefined);
}

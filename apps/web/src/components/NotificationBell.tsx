import { useEffect, useState, useCallback } from 'react';
import { Popover, ActionIcon, Indicator, Stack, Text, Paper, Group, Button, ScrollArea } from '@mantine/core';
import { listNotifications, markAllNotificationsRead, markNotificationRead, type NotificationItem } from '../lib/auditApi.js';

/**
 * Role-based alerting, in-app — docs/PLATFORM_BLUEPRINT.md §09. Polls
 * services/audit-service for the signed-in practitioner's notifications:
 * every edit to a note or prescription fans out an alert to role
 * subscribers (admin/compliance — see scripts/seed/'s alert_subscriptions
 * seed) and to the original author if someone else made the edit.
 *
 * "Alerting" here means this bell, polled every 20s — no email/SMS/pager
 * integration. A real deployment needs those channels too; this is the
 * in-app layer, not the whole alerting story.
 */
export function NotificationBell({ practitionerId }: { practitionerId: string | undefined }) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [opened, setOpened] = useState(false);

  const reload = useCallback(() => {
    if (!practitionerId) return;
    listNotifications(practitionerId).then(setItems);
  }, [practitionerId]);

  useEffect(() => {
    reload();
    const interval = setInterval(reload, 20_000);
    return () => clearInterval(interval);
  }, [reload]);

  const unreadCount = items.filter((n) => !n.read).length;

  async function handleOpen() {
    setOpened((v) => !v);
  }

  async function handleRead(id: string) {
    await markNotificationRead(id);
    reload();
  }

  async function handleReadAll() {
    if (!practitionerId) return;
    await markAllNotificationsRead(practitionerId);
    reload();
  }

  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-end" withArrow shadow="md" width={360}>
      <Popover.Target>
        <Indicator label={unreadCount > 9 ? '9+' : unreadCount} size={16} disabled={unreadCount === 0} color="red">
          <ActionIcon variant="subtle" size="lg" onClick={handleOpen} aria-label="Notifications">
            🔔
          </ActionIcon>
        </Indicator>
      </Popover.Target>
      <Popover.Dropdown p="xs">
        <Group justify="space-between" mb="xs" px={4}>
          <Text size="sm" fw={600}>
            Notifications
          </Text>
          {unreadCount > 0 && (
            <Button size="compact-xs" variant="subtle" onClick={handleReadAll}>
              Mark all read
            </Button>
          )}
        </Group>
        <ScrollArea.Autosize mah={360}>
          <Stack gap={6}>
            {items.length === 0 ? (
              <Text size="sm" c="dimmed" px={4}>
                No notifications.
              </Text>
            ) : (
              items.map((n) => (
                <Paper
                  key={n.id}
                  p="xs"
                  withBorder
                  bg={n.read ? undefined : 'var(--mantine-color-blue-0)'}
                  style={{ cursor: n.read ? 'default' : 'pointer' }}
                  onClick={() => !n.read && handleRead(n.id)}
                >
                  <Text size="sm">
                    <strong>{n.actorName}</strong> {n.summary.charAt(0).toLowerCase() + n.summary.slice(1)}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {n.reason === 'original_author' ? 'You authored this' : 'Subscribed role'} ·{' '}
                    {new Date(n.createdAt).toLocaleString()}
                  </Text>
                </Paper>
              ))
            )}
          </Stack>
        </ScrollArea.Autosize>
      </Popover.Dropdown>
    </Popover>
  );
}

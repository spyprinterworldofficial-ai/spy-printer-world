import React, { useCallback, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, ActivityIndicator, RefreshControl, Alert, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { adminApi } from '../api/admin';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const rupees = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;

function thisMonth() {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000); // Indian time
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() };
}
const key = ({ y, m }) => `${y}-${String(m + 1).padStart(2, '0')}`;
const shift = ({ y, m }, by) => ({ y: y + Math.floor((m + by) / 12), m: (((m + by) % 12) + 12) % 12 });

export default function VendorsScreen({ navigation }) {
  const [month, setMonth] = useState(thisMonth());
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const isCurrent = key(month) === key(thisMonth());

  const load = useCallback(async () => {
    try {
      setError(null);
      setData(await adminApi.vendorsOverview(key(month)));
    } catch (e) {
      setError(e.message);
    }
  }, [month]);

  useFocusEffect(useCallback(() => { setData(null); load(); }, [load]));

  const act = async (id, fn) => {
    setBusyId(id);
    try {
      await fn();
      await load();
    } catch (e) {
      Alert.alert('Could not update', e.message);
    } finally {
      setBusyId(null);
    }
  };

  const pause = (v) =>
    Alert.alert(`Pause ${v.displayName || v.username}?`, 'They are signed out and cannot sign in until you resume them.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Pause account only', onPress: () => act(v.id, () => adminApi.pauseVendor(v.id, false)) },
      {
        text: 'Pause + switch off their printers',
        style: 'destructive',
        onPress: () => act(v.id, () => adminApi.pauseVendor(v.id, true)),
      },
    ]);

  const resume = (v) =>
    act(v.id, async () => {
      const r = await adminApi.resumeVendor(v.id);
      if (r.printersSwitchedOn) Alert.alert('Resumed', `${r.printersSwitchedOn} printer(s) switched back on.`);
    });

  const remove = (v) =>
    Alert.alert(
      `Remove ${v.displayName || v.username}?`,
      'Their login and printer access are deleted. Printers and print history stay as they are. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => act(v.id, () => adminApi.deleteUser(v.id)) },
      ],
    );

  const renderItem = ({ item: v }) => {
    const busy = busyId === v.id;
    return (
      <View style={[styles.card, !v.isActive && styles.cardOff]}>
        <TouchableOpacity onPress={() => navigation.navigate('UserEdit', { userId: v.id })} style={styles.head}>
          <View style={{ flex: 1 }}>
            <Text style={styles.name}>{v.displayName || v.username}</Text>
            <Text style={styles.muted}>@{v.username} · {v.printerCount} printer{v.printerCount === 1 ? '' : 's'}</Text>
          </View>
          <Text style={v.isActive ? styles.tagOk : styles.tagOff}>
            {v.isActive ? 'Active' : v.printersPaused ? 'Paused + printers off' : 'Paused'}
          </Text>
        </TouchableOpacity>

        <View style={styles.stats}>
          <Stat label="Pages printed" value={v.pages.toLocaleString('en-IN')} />
          <Stat label="Prints" value={v.prints.toLocaleString('en-IN')} />
          <Stat label="Revenue" value={rupees(v.revenue)} accent />
        </View>

        <View style={styles.actions}>
          {busy ? (
            <ActivityIndicator color="#36d1dc" style={{ flex: 1 }} />
          ) : (
            <>
              {v.isActive ? (
                <TouchableOpacity style={styles.btnWarn} onPress={() => pause(v)}>
                  <Text style={styles.btnWarnText}>Pause</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity style={styles.btnOk} onPress={() => resume(v)}>
                  <Text style={styles.btnOkText}>Resume</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity style={styles.btnDanger} onPress={() => remove(v)}>
                <Text style={styles.btnDangerText}>Remove</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    );
  };

  const header = (
    <View style={{ gap: 12 }}>
      <View style={styles.monthBar}>
        <TouchableOpacity onPress={() => setMonth((m) => shift(m, -1))} hitSlop={12}>
          <Text style={styles.arrow}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.month}>{MONTHS[month.m]} {month.y}{isCurrent ? ' (so far)' : ''}</Text>
        <TouchableOpacity onPress={() => !isCurrent && setMonth((m) => shift(m, 1))} disabled={isCurrent} hitSlop={12}>
          <Text style={[styles.arrow, isCurrent && { opacity: 0.25 }]}>›</Text>
        </TouchableOpacity>
      </View>
      {data && (
        <View style={[styles.card, styles.stats]}>
          <Stat label="All vendors: pages" value={data.totals.pages.toLocaleString('en-IN')} />
          <Stat label="Prints" value={data.totals.prints.toLocaleString('en-IN')} />
          <Stat label="Revenue" value={rupees(data.totals.revenue)} accent />
        </View>
      )}
    </View>
  );

  if (error) return <Text style={styles.error}>{error}</Text>;
  return (
    <FlatList
      data={data?.vendors || []}
      keyExtractor={(v) => v.id}
      renderItem={renderItem}
      ListHeaderComponent={header}
      ListEmptyComponent={data ? <Text style={styles.empty}>No vendors yet. Add one in Manage users.</Text> : <ActivityIndicator style={{ marginTop: 30 }} color="#36d1dc" />}
      contentContainerStyle={{ padding: 16, gap: 12 }}
      refreshControl={<RefreshControl refreshing={refreshing} tintColor="#36d1dc" onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
    />
  );
}

function Stat({ label, value, accent }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, accent && { color: '#3ddc84' }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  monthBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#131a21', borderRadius: 12, paddingHorizontal: 18, paddingVertical: 10, borderWidth: 1, borderColor: '#1f2933' },
  arrow: { color: '#36d1dc', fontSize: 28, fontWeight: '700' },
  month: { color: '#fff', fontSize: 16, fontWeight: '700' },
  card: { backgroundColor: '#131a21', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#1f2933', gap: 12 },
  cardOff: { opacity: 0.7, borderColor: '#5a2a30' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { color: '#fff', fontWeight: '700', fontSize: 16 },
  muted: { color: '#8a97a5', fontSize: 12 },
  tagOk: { color: '#3ddc84', fontWeight: '700', fontSize: 12 },
  tagOff: { color: '#ff5f6d', fontWeight: '700', fontSize: 12 },
  stats: { flexDirection: 'row', gap: 10 },
  statLabel: { color: '#8a97a5', fontSize: 11 },
  statValue: { color: '#fff', fontSize: 17, fontWeight: '700', marginTop: 2 },
  actions: { flexDirection: 'row', gap: 10, minHeight: 40 },
  btnWarn: { flex: 1, borderWidth: 1, borderColor: '#fbbf24', borderRadius: 10, padding: 10, alignItems: 'center' },
  btnWarnText: { color: '#fbbf24', fontWeight: '700' },
  btnOk: { flex: 1, borderWidth: 1, borderColor: '#3ddc84', borderRadius: 10, padding: 10, alignItems: 'center' },
  btnOkText: { color: '#3ddc84', fontWeight: '700' },
  btnDanger: { flex: 1, borderWidth: 1, borderColor: '#ff5f6d', borderRadius: 10, padding: 10, alignItems: 'center' },
  btnDangerText: { color: '#ff5f6d', fontWeight: '700' },
  empty: { color: '#8a97a5', textAlign: 'center', marginTop: 30 },
  error: { color: '#ff5f6d', padding: 20 },
});

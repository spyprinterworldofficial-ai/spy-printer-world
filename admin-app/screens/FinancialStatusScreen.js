import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, ScrollView } from 'react-native';
import { api } from '../api/client';

export default function FinancialStatusScreen({ route, navigation }) {
  const { printerId, printerName } = route.params;
  const [today, setToday] = useState(null);
  const [total, setTotal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showTodayOrders, setShowTodayOrders] = useState(false);
  const [showBreakdown, setShowBreakdown] = useState(null); // 'monthly' | 'weekly' | 'yearly' | null

  useEffect(() => {
    navigation.setOptions({ title: `${printerName} — Financials` });
    Promise.all([api.getFinanceToday(printerId), api.getFinanceTotal(printerId)])
      .then(([t, tot]) => { setToday(t); setTotal(tot); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [printerId]);

  if (loading || !today || !total) return <ActivityIndicator color="#36d1dc" style={{ flex: 1, backgroundColor: '#0a0e12' }} />;

  const breakdownData = showBreakdown ? total[showBreakdown] : [];

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16 }}>
      <TouchableOpacity style={styles.card} onPress={() => setShowTodayOrders(!showTodayOrders)}>
        <Text style={styles.label}>Total revenue today</Text>
        <Text style={styles.statNumber}>₹{today.totalRevenue.toFixed(2)}</Text>
        <Text style={styles.hint}>{today.orderCount} orders — tap to {showTodayOrders ? 'hide' : 'view'}</Text>
      </TouchableOpacity>

      {showTodayOrders && today.orders.map((o) => (
        <View key={o.id} style={styles.orderRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.orderFile} numberOfLines={1}>{o.fileName}</Text>
            <Text style={styles.orderRef}>{o.paymentRef || 'pending ref'}</Text>
          </View>
          <Text style={styles.orderAmount}>₹{Number(o.amount).toFixed(2)}</Text>
        </View>
      ))}

      <View style={styles.card}>
        <Text style={styles.label}>Total revenue (all time)</Text>
        <Text style={styles.statNumber}>₹{total.totalRevenue.toFixed(2)}</Text>

        <View style={styles.tabRow}>
          {['monthly', 'weekly', 'yearly'].map((key) => (
            <TouchableOpacity
              key={key}
              style={[styles.tab, showBreakdown === key && styles.tabActive]}
              onPress={() => setShowBreakdown(showBreakdown === key ? null : key)}
            >
              <Text style={[styles.tabText, showBreakdown === key && styles.tabTextActive]}>
                {key[0].toUpperCase() + key.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {showBreakdown && (
          <View style={{ marginTop: 12 }}>
            {breakdownData.map((row) => (
              <View key={row.period} style={styles.breakdownRow}>
                <Text style={styles.breakdownPeriod}>{row.period}</Text>
                <Text style={styles.breakdownAmount}>₹{row.revenue.toFixed(2)}</Text>
              </View>
            ))}
          </View>
        )}
      </View>

      <TouchableOpacity
        style={styles.card}
        onPress={() => navigation.navigate('RevenueHistory', { printerId, printerName })}
      >
        <Text style={styles.linkText}>Full payment history →</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0e12' },
  card: { backgroundColor: '#131a21', borderRadius: 12, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: '#1f2933' },
  label: { color: '#cbd5e1', fontSize: 14, fontWeight: '600' },
  hint: { color: '#64748b', fontSize: 12, marginTop: 4 },
  statNumber: { color: '#4ade80', fontSize: 30, fontWeight: 'bold', marginVertical: 4 },
  linkText: { color: '#36d1dc', fontSize: 15, fontWeight: '600' },
  orderRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: '#0f151b', borderRadius: 8, padding: 12, marginBottom: 6, marginLeft: 8,
  },
  orderFile: { color: '#e2e8f0', fontSize: 13 },
  orderRef: { color: '#64748b', fontSize: 11, marginTop: 2 },
  orderAmount: { color: '#4ade80', fontWeight: '600' },
  tabRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  tab: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: '#0f151b', borderWidth: 1, borderColor: '#2a3644' },
  tabActive: { backgroundColor: '#36d1dc', borderColor: '#36d1dc' },
  tabText: { color: '#94a3b8', fontSize: 12 },
  tabTextActive: { color: '#041019', fontWeight: 'bold' },
  breakdownRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#1f2933' },
  breakdownPeriod: { color: '#cbd5e1', fontSize: 13 },
  breakdownAmount: { color: '#4ade80', fontSize: 13, fontWeight: '600' },
});
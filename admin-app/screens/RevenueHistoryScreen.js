import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, FlatList, StyleSheet, ActivityIndicator } from 'react-native';
import { api } from '../api/client';

export default function RevenueHistoryScreen({ route, navigation }) {
  const { printerId, printerName } = route.params;
  const [orders, setOrders] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    navigation.setOptions({ title: `${printerName} — Payment History` });
  }, []);

  useEffect(() => {
    setLoading(true);
    api.getFinanceHistory(printerId, 1)
      .then((data) => { setOrders(data.orders); setTotal(data.total); setPage(1); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [printerId]);

  const loadMore = useCallback(async () => {
    if (loadingMore || orders.length >= total) return;
    setLoadingMore(true);
    try {
      const nextPage = page + 1;
      const data = await api.getFinanceHistory(printerId, nextPage);
      setOrders((prev) => [...prev, ...data.orders]);
      setPage(nextPage);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingMore(false);
    }
  }, [page, orders.length, total, loadingMore]);

  if (loading) return <ActivityIndicator color="#36d1dc" style={{ flex: 1, backgroundColor: '#0a0e12' }} />;

  return (
    <View style={styles.container}>
      <FlatList
        data={orders}
        keyExtractor={(item) => item.id}
        onEndReached={loadMore}
        onEndReachedThreshold={0.4}
        ListFooterComponent={loadingMore ? <ActivityIndicator color="#36d1dc" style={{ marginVertical: 16 }} /> : null}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.fileName} numberOfLines={1}>{item.fileName}</Text>
              <Text style={styles.meta}>{new Date(item.createdAt).toLocaleString()}</Text>
              <Text style={styles.ref}>{item.paymentRef || '—'}</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={styles.amount}>₹{Number(item.amount).toFixed(2)}</Text>
              <Text style={styles.pages}>{item.pages} pg</Text>
            </View>
          </View>
        )}
        ListEmptyComponent={<Text style={styles.empty}>No payment history yet.</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0e12', padding: 16 },
  row: {
    flexDirection: 'row', justifyContent: 'space-between', backgroundColor: '#131a21',
    borderRadius: 10, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: '#1f2933',
  },
  fileName: { color: '#fff', fontSize: 14, fontWeight: '600' },
  meta: { color: '#64748b', fontSize: 12, marginTop: 2 },
  ref: { color: '#475569', fontSize: 11, marginTop: 2 },
  amount: { color: '#4ade80', fontSize: 15, fontWeight: 'bold' },
  pages: { color: '#64748b', fontSize: 11, marginTop: 2 },
  empty: { color: '#64748b', textAlign: 'center', marginTop: 40 },
});
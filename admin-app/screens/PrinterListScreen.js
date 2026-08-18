import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { api } from '../api/client';
import { isInternetOnline, isPrinterConnected } from '../utils/printerStatus';

export default function PrinterListScreen({ route, navigation }) {
  const { instituteId, instituteName } = route.params;
  const [printers, setPrinters] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    navigation.setOptions({ title: instituteName });
    const load = () => api.getPrinters(instituteId).then(setPrinters).catch(console.error).finally(() => setLoading(false));
    load();
    // Poll periodically so an offline dot actually goes red while you're
    // looking at the screen, rather than only updating on next navigation.
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, [instituteId]);

  if (loading) return <ActivityIndicator color="#36d1dc" style={{ flex: 1, backgroundColor: '#0a0e12' }} />;

  return (
    <View style={styles.container}>
      <FlatList
        data={printers}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.row}
            onPress={() => navigation.navigate('PrinterDetail', { printerId: item.id, printerName: item.name })}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>{item.name}</Text>
              <Text style={styles.rowSubtitle}>{item.paper_remaining} pages left</Text>
            </View>
            <View style={[styles.dot, { backgroundColor: isInternetOnline(item) && isPrinterConnected(item) ? '#4ade80' : '#f87171' }]} />
          </TouchableOpacity>
        )}
        ListEmptyComponent={<Text style={styles.empty}>No printers registered for this institute.</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0e12', padding: 16 },
  row: { backgroundColor: '#131a21', borderRadius: 10, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#1f2933', flexDirection: 'row', alignItems: 'center' },
  rowTitle: { color: '#fff', fontSize: 16, fontWeight: '600' },
  rowSubtitle: { color: '#94a3b8', fontSize: 13, marginTop: 2 },
  dot: { width: 10, height: 10, borderRadius: 5, marginLeft: 10 },
  empty: { color: '#64748b', textAlign: 'center', marginTop: 40 },
});
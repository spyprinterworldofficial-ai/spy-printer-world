import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, StyleSheet, ActivityIndicator } from 'react-native';
import { api } from '../api/client';

export default function PrintHistoryScreen({ route, navigation }) {
  const { printerId, printerName } = route.params;
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    navigation.setOptions({ title: `${printerName} — History` });
    api.getPrinterHistory(printerId, 60).then(setHistory).catch(console.error).finally(() => setLoading(false));
  }, [printerId]);

  if (loading) return <ActivityIndicator color="#36d1dc" style={{ flex: 1, backgroundColor: '#0a0e12' }} />;

  return (
    <View style={styles.container}>
      <FlatList
        data={history}
        keyExtractor={(item) => item.date}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Text style={styles.date}>{item.date}</Text>
            <Text style={styles.stat}>{item.prints} prints · {item.pages} pages</Text>
          </View>
        )}
        ListEmptyComponent={<Text style={styles.empty}>No print history yet.</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0e12', padding: 16 },
  row: { backgroundColor: '#131a21', borderRadius: 10, padding: 14, marginBottom: 8, flexDirection: 'row', justifyContent: 'space-between', borderWidth: 1, borderColor: '#1f2933' },
  date: { color: '#fff', fontSize: 14, fontWeight: '600' },
  stat: { color: '#94a3b8', fontSize: 13 },
  empty: { color: '#64748b', textAlign: 'center', marginTop: 40 },
});
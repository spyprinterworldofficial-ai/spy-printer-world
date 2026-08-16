import React, { useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

export default function PrinterDetailScreen({ route, navigation }) {
  const { printerId, printerName } = route.params;

  useEffect(() => {
    navigation.setOptions({ title: printerName });
  }, [printerName]);

  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={styles.card}
        onPress={() => navigation.navigate('PrinterStatus', { printerId, printerName })}
      >
        <Text style={styles.cardIcon}>🖨️</Text>
        <Text style={styles.cardTitle}>Printer Status</Text>
        <Text style={styles.cardSubtitle}>Enable/disable, paper, connectivity, print history</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.card}
        onPress={() => navigation.navigate('FinancialStatus', { printerId, printerName })}
      >
        <Text style={styles.cardIcon}>💰</Text>
        <Text style={styles.cardTitle}>Financial Status</Text>
        <Text style={styles.cardSubtitle}>Revenue today, totals, full payment history</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0e12', padding: 16, justifyContent: 'center', gap: 16 },
  card: { backgroundColor: '#131a21', borderRadius: 16, padding: 24, borderWidth: 1, borderColor: '#1f2933', marginBottom: 16 },
  cardIcon: { fontSize: 32, marginBottom: 8 },
  cardTitle: { color: '#fff', fontSize: 20, fontWeight: 'bold', marginBottom: 4 },
  cardSubtitle: { color: '#94a3b8', fontSize: 13 },
});
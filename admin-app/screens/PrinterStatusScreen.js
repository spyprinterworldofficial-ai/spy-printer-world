import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, Switch, TouchableOpacity, StyleSheet, ActivityIndicator, TextInput, Alert, ScrollView } from 'react-native';
import { api } from '../api/client';

export default function PrinterStatusScreen({ route, navigation }) {
  const { printerId, printerName } = route.params;
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [paperInput, setPaperInput] = useState('');
  const [showPaperInput, setShowPaperInput] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.getPrinterStatus(printerId);
      setStatus(data);
    } catch (err) {
      Alert.alert('Error', err.message);
    } finally {
      setLoading(false);
    }
  }, [printerId]);

  useEffect(() => {
    navigation.setOptions({ title: `${printerName} — Status` });
    load();
    const interval = setInterval(load, 15000); // keep connectivity/paper reasonably live
    return () => clearInterval(interval);
  }, [load]);

  const toggleEnabled = async (value) => {
    try {
      await api.setPrinterEnabled(printerId, value);
      load();
    } catch (err) {
      Alert.alert('Error', err.message);
    }
  };

  const submitPaperCount = async () => {
    const num = Number(paperInput);
    if (isNaN(num) || num < 0) {
      Alert.alert('Invalid number', 'Enter a non-negative number of pages.');
      return;
    }
    try {
      await api.setPaperRemaining(printerId, num);
      setShowPaperInput(false);
      setPaperInput('');
      load();
    } catch (err) {
      Alert.alert('Error', err.message);
    }
  };

  const handleResetCartridge = () => {
    Alert.alert('Reset cartridge counter?', 'Only do this after physically replacing the toner cartridge.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reset', style: 'destructive', onPress: async () => { await api.resetCartridge(printerId); load(); } },
    ]);
  };

  if (loading || !status) return <ActivityIndicator color="#36d1dc" style={{ flex: 1, backgroundColor: '#0a0e12' }} />;

  const { printer, totalPagesPrinted, printsToday, pagesToday, cartridgeDutyCycle, cartridgePercentUsed } = status;

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16 }}>
      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.label}>Printer Enabled</Text>
          <Switch
            value={printer.is_enabled}
            onValueChange={toggleEnabled}
            trackColor={{ false: '#3f3f46', true: '#36d1dc' }}
          />
        </View>
        <Text style={styles.hint}>
          Disabling force-stops new prints — use if paper is critically low or something's wrong physically.
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.statNumber}>{totalPagesPrinted}</Text>
        <Text style={styles.label}>Total pages printed (lifetime)</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.statNumber}>{printsToday}</Text>
        <Text style={styles.label}>Prints today ({pagesToday} pages) — {new Date().toLocaleDateString()}</Text>
      </View>

      <TouchableOpacity
        style={styles.card}
        onPress={() => navigation.navigate('PrintHistory', { printerId, printerName })}
      >
        <Text style={styles.linkText}>View print history by date →</Text>
      </TouchableOpacity>

      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.label}>Paper remaining</Text>
          <TouchableOpacity onPress={() => setShowPaperInput(!showPaperInput)}>
            <Text style={styles.linkTextSmall}>Set number of pages</Text>
          </TouchableOpacity>
        </View>
        <Text style={[styles.statNumber, { color: printer.paper_remaining < printer.min_paper_threshold ? '#f87171' : '#4ade80' }]}>
          {printer.paper_remaining} pages
        </Text>
        {showPaperInput && (
          <View style={styles.rowBetween}>
            <TextInput
              style={styles.paperInput}
              keyboardType="numeric"
              placeholder="e.g. 250"
              placeholderTextColor="#666"
              value={paperInput}
              onChangeText={setPaperInput}
            />
            <TouchableOpacity style={styles.smallButton} onPress={submitPaperCount}>
              <Text style={styles.smallButtonText}>Save</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>Cartridge usage</Text>
        <Text style={[styles.statNumber, { color: cartridgePercentUsed >= 95 ? '#f87171' : cartridgePercentUsed >= 80 ? '#fbbf24' : '#4ade80' }]}>
          {printer.cartridge_page_count} / {cartridgeDutyCycle} ({cartridgePercentUsed}%)
        </Text>
        <TouchableOpacity onPress={handleResetCartridge}>
          <Text style={styles.linkTextSmall}>Replace cartridge (reset counter)</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.label}>Pi internet connection</Text>
          <View style={[styles.dot, { backgroundColor: printer.pi_internet_online ? '#4ade80' : '#f87171' }]} />
        </View>
      </View>

      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.label}>Pi ↔ printer connection</Text>
          <View style={[styles.dot, { backgroundColor: printer.pi_printer_connected ? '#4ade80' : '#f87171' }]} />
        </View>
        <Text style={styles.hint}>
          Turns red if the Pi can't reach the printer — including if someone unplugs it and connects their own device instead.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0e12' },
  card: { backgroundColor: '#131a21', borderRadius: 12, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: '#1f2933' },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { color: '#cbd5e1', fontSize: 14, fontWeight: '600' },
  hint: { color: '#64748b', fontSize: 12, marginTop: 6 },
  statNumber: { color: '#fff', fontSize: 28, fontWeight: 'bold', marginVertical: 4 },
  linkText: { color: '#36d1dc', fontSize: 15, fontWeight: '600' },
  linkTextSmall: { color: '#36d1dc', fontSize: 13, marginTop: 6 },
  dot: { width: 14, height: 14, borderRadius: 7 },
  paperInput: {
    flex: 1, backgroundColor: '#0a0e12', color: '#fff', borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 8, marginRight: 8, borderWidth: 1, borderColor: '#2a3644',
  },
  smallButton: { backgroundColor: '#36d1dc', borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8 },
  smallButtonText: { color: '#041019', fontWeight: 'bold' },
});
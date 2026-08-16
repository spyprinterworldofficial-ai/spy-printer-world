import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, TextInput, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Modal } from 'react-native';
import { api } from '../api/client';

export default function InstituteListScreen({ navigation }) {
  const [search, setSearch] = useState('');
  const [institutes, setInstitutes] = useState([]);
  const [states, setStates] = useState([]);
  const [selectedState, setSelectedState] = useState(null);
  const [sort, setSort] = useState('alpha'); // 'alpha' | 'recent'
  const [loading, setLoading] = useState(true);
  const [filterModalVisible, setFilterModalVisible] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { sort };
      if (search) params.search = search;
      if (selectedState) params.state = selectedState;
      const data = await api.getInstitutes(params);
      setInstitutes(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [search, selectedState, sort]);

  useEffect(() => {
    api.getStates().then(setStates).catch(console.error);
  }, []);

  useEffect(() => {
    const debounce = setTimeout(load, 300);
    return () => clearTimeout(debounce);
  }, [load]);

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.searchBar}
        placeholder="Search institute"
        placeholderTextColor="#888"
        value={search}
        onChangeText={setSearch}
      />

      <View style={styles.filterRow}>
        <Text style={styles.filterLabel}>Select institute</Text>
        <TouchableOpacity style={styles.filterButton} onPress={() => setFilterModalVisible(true)}>
          <Text style={styles.filterButtonText}>
            {selectedState ? selectedState : 'Filter'} {sort === 'alpha' ? '(A-Z)' : ''}
          </Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator color="#36d1dc" style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={institutes}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingBottom: 24 }}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.row}
              onPress={() => navigation.navigate('PrinterList', { instituteId: item.id, instituteName: item.name })}
            >
              <Text style={styles.rowTitle}>{item.name}</Text>
              <Text style={styles.rowSubtitle}>{item.state}</Text>
            </TouchableOpacity>
          )}
          ListEmptyComponent={<Text style={styles.empty}>No institutes match.</Text>}
        />
      )}

      <Modal visible={filterModalVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Filter by state</Text>
            <FlatList
              data={[{ label: 'All states', value: null }, ...states.map((s) => ({ label: s, value: s }))]}
              keyExtractor={(item) => item.label}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.modalRow}
                  onPress={() => { setSelectedState(item.value); setFilterModalVisible(false); }}
                >
                  <Text style={styles.modalRowText}>{item.label}</Text>
                </TouchableOpacity>
              )}
            />

            <Text style={[styles.modalTitle, { marginTop: 16 }]}>Sort</Text>
            <TouchableOpacity style={styles.modalRow} onPress={() => { setSort('alpha'); setFilterModalVisible(false); }}>
              <Text style={styles.modalRowText}>Alphabetical (A-Z)</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.modalRow} onPress={() => { setSort('recent'); setFilterModalVisible(false); }}>
              <Text style={styles.modalRowText}>Recently added</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.closeButton} onPress={() => setFilterModalVisible(false)}>
              <Text style={styles.closeButtonText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0e12', padding: 16 },
  searchBar: {
    backgroundColor: '#171f27', color: '#fff', borderRadius: 10,
    paddingHorizontal: 16, paddingVertical: 12, borderWidth: 1, borderColor: '#2a3644',
  },
  filterRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginVertical: 14 },
  filterLabel: { color: '#cbd5e1', fontSize: 15, fontWeight: '600' },
  filterButton: { backgroundColor: '#171f27', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: '#2a3644' },
  filterButtonText: { color: '#36d1dc', fontSize: 13 },
  row: { backgroundColor: '#131a21', borderRadius: 10, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#1f2933' },
  rowTitle: { color: '#fff', fontSize: 16, fontWeight: '600' },
  rowSubtitle: { color: '#94a3b8', fontSize: 13, marginTop: 2 },
  empty: { color: '#64748b', textAlign: 'center', marginTop: 40 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#131a21', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 20, maxHeight: '70%' },
  modalTitle: { color: '#fff', fontSize: 15, fontWeight: 'bold', marginBottom: 8 },
  modalRow: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#1f2933' },
  modalRowText: { color: '#cbd5e1', fontSize: 15 },
  closeButton: { marginTop: 16, alignItems: 'center', paddingVertical: 12 },
  closeButtonText: { color: '#36d1dc', fontWeight: '600' },
});
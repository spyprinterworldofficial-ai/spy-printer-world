import React, { useCallback, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, ActivityIndicator, RefreshControl, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { adminApi } from '../api/admin';

export default function UsersScreen({ navigation }) {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      setUsers(await adminApi.listUsers());
    } catch (e) {
      setError(e.message);
    }
  }, []);

  // Reload whenever we come back from the edit screen.
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const renderItem = ({ item }) => {
    const isSuper = item.role === 'SUPER_ADMIN';
    return (
      <TouchableOpacity
        style={[styles.row, !item.isActive && { opacity: 0.55 }]}
        disabled={isSuper}
        onPress={() => navigation.navigate('UserEdit', { userId: item.id })}
      >
        <View style={{ flex: 1 }}>
          <Text style={styles.name}>{item.displayName || item.username}</Text>
          <Text style={styles.muted}>@{item.username}</Text>
        </View>
        <View style={{ alignItems: 'flex-end', gap: 4 }}>
          <Text style={isSuper ? styles.tagSuper : item.isActive ? styles.tagOk : styles.tagOff}>
            {isSuper ? 'Super admin' : item.isActive ? 'Active' : 'Disabled'}
          </Text>
          <Text style={styles.muted}>{isSuper ? 'all printers' : `${item.printerCount} printer${item.printerCount === 1 ? '' : 's'}`}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  if (error) return <Text style={styles.error}>{error}</Text>;
  if (!users) return <ActivityIndicator style={{ marginTop: 40 }} color="#36d1dc" />;

  return (
    <View style={{ flex: 1 }}>
      <TouchableOpacity style={styles.add} onPress={() => navigation.navigate('UserEdit', {})}>
        <Text style={styles.addText}>+ New vendor</Text>
      </TouchableOpacity>
      <FlatList
        data={users}
        keyExtractor={(u) => u.id}
        renderItem={renderItem}
        contentContainerStyle={{ padding: 16, paddingTop: 4, gap: 10 }}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor="#36d1dc" onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  add: { margin: 16, marginBottom: 8, backgroundColor: '#36d1dc', borderRadius: 10, padding: 14, alignItems: 'center' },
  addText: { color: '#041019', fontWeight: '700' },
  row: { flexDirection: 'row', backgroundColor: '#131a21', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#1f2933', alignItems: 'center' },
  name: { color: '#fff', fontWeight: '700', fontSize: 16 },
  muted: { color: '#8a97a5', fontSize: 12 },
  tagOk: { color: '#3ddc84', fontWeight: '700', fontSize: 12 },
  tagOff: { color: '#ff5f6d', fontWeight: '700', fontSize: 12 },
  tagSuper: { color: '#36d1dc', fontWeight: '700', fontSize: 12 },
  error: { color: '#ff5f6d', padding: 20 },
});
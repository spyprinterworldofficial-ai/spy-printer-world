import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Switch, ActivityIndicator, Alert, StyleSheet } from 'react-native';
import { adminApi } from '../api/admin';

const USERNAME = /^[a-zA-Z0-9._-]{3,32}$/;

export default function UserEditScreen({ route, navigation }) {
  const userId = route.params?.userId;
  const isNew = !userId;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [options, setOptions] = useState([]);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [selected, setSelected] = useState(new Set());

  useEffect(() => {
    navigation.setOptions({ title: isNew ? 'New vendor' : 'Edit vendor' });
    (async () => {
      try {
        setOptions(await adminApi.getPrinterOptions());
        if (!isNew) {
          const u = await adminApi.getUser(userId);
          setUsername(u.username);
          setDisplayName(u.displayName || '');
          setIsActive(u.isActive);
          setSelected(new Set(u.printerIds));
        }
      } catch (e) {
        Alert.alert('Could not load', e.message, [{ text: 'OK', onPress: () => navigation.goBack() }]);
      } finally {
        setLoading(false);
      }
    })();
  }, [userId]);

  const groups = useMemo(() => {
    const map = new Map();
    for (const p of options) {
      if (!map.has(p.instituteId)) map.set(p.instituteId, { name: p.instituteName, printers: [] });
      map.get(p.instituteId).printers.push(p);
    }
    return [...map.values()];
  }, [options]);

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const toggleGroup = (group) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const all = group.printers.every((p) => next.has(p.id));
      group.printers.forEach((p) => (all ? next.delete(p.id) : next.add(p.id)));
      return next;
    });

  const save = async () => {
    if (isNew && !USERNAME.test(username)) return Alert.alert('Username', '3-32 characters: letters, numbers, dot, dash or underscore.');
    if ((isNew || password) && password.length < 8) return Alert.alert('Password', 'Use at least 8 characters.');
    setSaving(true);
    try {
      const printerIds = [...selected];
      if (isNew) {
        await adminApi.createUser({ username, password, displayName, printerIds });
      } else {
        await adminApi.updateUser(userId, { displayName, isActive, ...(password ? { password } : {}) });
        await adminApi.setUserPrinters(userId, printerIds);
      }
      navigation.goBack();
    } catch (e) {
      Alert.alert('Could not save', e.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = () =>
    Alert.alert('Delete this vendor?', `${username} will lose access immediately. This can't be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await adminApi.deleteUser(userId);
            navigation.goBack();
          } catch (e) {
            Alert.alert('Could not delete', e.message);
          }
        },
      },
    ]);

  if (loading) return <ActivityIndicator style={{ marginTop: 40 }} color="#36d1dc" />;

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <View style={styles.card}>
        {isNew ? (
          <TextInput style={styles.input} placeholder="Username (they sign in with this)" placeholderTextColor="#6b7785" value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} />
        ) : (
          <Text style={styles.username}>@{username}</Text>
        )}
        <TextInput style={styles.input} placeholder="Name (optional, e.g. Hostel 2 vendor)" placeholderTextColor="#6b7785" value={displayName} onChangeText={setDisplayName} />
        <TextInput
          style={styles.input}
          placeholder={isNew ? 'Password (8+ characters)' : 'New password (leave blank to keep)'}
          placeholderTextColor="#6b7785"
          value={password}
          onChangeText={setPassword}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {!isNew && (
          <View style={styles.switchRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Account active</Text>
              <Text style={styles.muted}>Turn off to lock them out immediately.</Text>
            </View>
            <Switch value={isActive} onValueChange={setIsActive} />
          </View>
        )}
        {!isNew && password.length > 0 && <Text style={styles.muted}>Setting a new password also signs them out of all devices.</Text>}
      </View>

      <Text style={styles.section}>Printers they can operate ({selected.size})</Text>
      {groups.length === 0 && <Text style={styles.muted}>No printers exist yet.</Text>}
      {groups.map((g) => (
        <View key={g.name} style={styles.card}>
          <TouchableOpacity onPress={() => toggleGroup(g)}>
            <Text style={styles.group}>{g.name}  <Text style={styles.groupAction}>{g.printers.every((p) => selected.has(p.id)) ? 'clear all' : 'select all'}</Text></Text>
          </TouchableOpacity>
          {g.printers.map((p) => (
            <TouchableOpacity key={p.id} style={styles.printerRow} onPress={() => toggle(p.id)}>
              <View style={[styles.box, selected.has(p.id) && styles.boxOn]}>{selected.has(p.id) && <Text style={styles.tick}>✓</Text>}</View>
              <Text style={styles.printerName}>{p.name}</Text>
            </TouchableOpacity>
          ))}
        </View>
      ))}

      <TouchableOpacity style={[styles.save, saving && { opacity: 0.5 }]} disabled={saving} onPress={save}>
        <Text style={styles.saveText}>{saving ? 'Saving...' : isNew ? 'Create vendor' : 'Save changes'}</Text>
      </TouchableOpacity>
      {!isNew && (
        <TouchableOpacity style={styles.delete} onPress={remove}>
          <Text style={styles.deleteText}>Delete vendor</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 12, paddingBottom: 40 },
  card: { backgroundColor: '#131a21', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#1f2933', gap: 10 },
  input: { backgroundColor: '#0a0e12', color: '#fff', borderRadius: 8, borderWidth: 1, borderColor: '#1f2933', padding: 12 },
  username: { color: '#fff', fontWeight: '700', fontSize: 18 },
  label: { color: '#fff', fontWeight: '600' },
  muted: { color: '#8a97a5', fontSize: 12 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  section: { color: '#fff', fontWeight: '700', fontSize: 16, marginTop: 6 },
  group: { color: '#fff', fontWeight: '700' },
  groupAction: { color: '#36d1dc', fontWeight: '600', fontSize: 12 },
  printerRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
  printerName: { color: '#dfe6ee', fontSize: 15 },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: '#4a5866', alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: '#36d1dc', borderColor: '#36d1dc' },
  tick: { color: '#041019', fontWeight: '800', fontSize: 14 },
  save: { backgroundColor: '#36d1dc', borderRadius: 10, padding: 14, alignItems: 'center', marginTop: 6 },
  saveText: { color: '#041019', fontWeight: '700' },
  delete: { borderColor: '#ff5f6d', borderWidth: 1, borderRadius: 10, padding: 14, alignItems: 'center' },
  deleteText: { color: '#ff5f6d', fontWeight: '700' },
});
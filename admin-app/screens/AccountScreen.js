import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, Alert, StyleSheet } from 'react-native';
import { clearToken, saveToken } from '../api/client';
import { adminApi } from '../api/admin';

export default function AccountScreen({ navigation }) {
  const [me, setMe] = useState(null);
  const [error, setError] = useState(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    adminApi.getMe().then(setMe).catch((e) => setError(e.message));
  }, []);

  const signOut = async () => {
    await clearToken();
    navigation.reset({ index: 0, routes: [{ name: 'Login' }] });
  };

  const changePassword = async () => {
    if (next.length < 8) return Alert.alert('Password too short', 'Use at least 8 characters.');
    if (next !== confirm) return Alert.alert("Passwords don't match", 'Type the new password twice the same way.');
    setBusy(true);
    try {
      const { token } = await adminApi.changePassword(current, next);
      await saveToken(token); // the old token stops working the moment the password changes
      setCurrent('');
      setNext('');
      setConfirm('');
      Alert.alert('Password changed', 'Your other sessions have been signed out.');
    } catch (e) {
      Alert.alert('Could not change password', e.message);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <Text style={styles.error}>{error}</Text>;
  if (!me) return <ActivityIndicator style={{ marginTop: 40 }} color="#36d1dc" />;

  const isSuper = me.role === 'SUPER_ADMIN';
  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <View style={styles.card}>
        <Text style={styles.name}>{me.displayName || me.username}</Text>
        <Text style={styles.muted}>@{me.username}</Text>
        <View style={[styles.badge, isSuper ? styles.badgeSuper : styles.badgeVendor]}>
          <Text style={styles.badgeText}>{isSuper ? 'Super admin — all printers' : 'Vendor — assigned printers only'}</Text>
        </View>
      </View>

      {isSuper && (
        <TouchableOpacity style={styles.primary} onPress={() => navigation.navigate('Users')}>
          <Text style={styles.primaryText}>Manage users &amp; printer access</Text>
        </TouchableOpacity>
      )}

      <View style={styles.card}>
        <Text style={styles.section}>Change password</Text>
        <TextInput style={styles.input} placeholder="Current password" placeholderTextColor="#6b7785" secureTextEntry value={current} onChangeText={setCurrent} autoCapitalize="none" />
        <TextInput style={styles.input} placeholder="New password (8+ characters)" placeholderTextColor="#6b7785" secureTextEntry value={next} onChangeText={setNext} autoCapitalize="none" />
        <TextInput style={styles.input} placeholder="Repeat new password" placeholderTextColor="#6b7785" secureTextEntry value={confirm} onChangeText={setConfirm} autoCapitalize="none" />
        <TouchableOpacity style={[styles.secondary, busy && { opacity: 0.5 }]} disabled={busy || !current || !next} onPress={changePassword}>
          <Text style={styles.secondaryText}>{busy ? 'Saving...' : 'Update password'}</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={styles.danger} onPress={signOut}>
        <Text style={styles.dangerText}>Sign out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 14 },
  card: { backgroundColor: '#131a21', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: '#1f2933', gap: 8 },
  name: { color: '#fff', fontSize: 20, fontWeight: '700' },
  muted: { color: '#8a97a5' },
  badge: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, marginTop: 4 },
  badgeSuper: { backgroundColor: 'rgba(54,209,220,0.15)' },
  badgeVendor: { backgroundColor: 'rgba(255,193,7,0.15)' },
  badgeText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  section: { color: '#fff', fontWeight: '700', fontSize: 16 },
  input: { backgroundColor: '#0a0e12', color: '#fff', borderRadius: 8, borderWidth: 1, borderColor: '#1f2933', padding: 12 },
  primary: { backgroundColor: '#36d1dc', borderRadius: 10, padding: 14, alignItems: 'center' },
  primaryText: { color: '#041019', fontWeight: '700' },
  secondary: { borderColor: '#36d1dc', borderWidth: 1, borderRadius: 10, padding: 12, alignItems: 'center' },
  secondaryText: { color: '#36d1dc', fontWeight: '600' },
  danger: { borderColor: '#ff5f6d', borderWidth: 1, borderRadius: 10, padding: 14, alignItems: 'center', marginTop: 6 },
  dangerText: { color: '#ff5f6d', fontWeight: '700' },
  error: { color: '#ff5f6d', padding: 20 },
});
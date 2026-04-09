import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader,
  TableRow
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { formatDate } from "@/lib/utils";
import api from "@/lib/api";
import { 
  ArrowLeft, 
  UserPlus, 
  Pencil, 
  Trash2, 
  Key, 
  Shield, 
  Mail, 
  MoreHorizontal,
  Calendar,
  GlobeLock,
  UserCog,
  Filter,
  ChevronDown,
  X,
  Eye
} from "lucide-react";
import { Link } from "react-router-dom";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import type { User, UserCreateRequest, UserUpdateRequest } from "@/types/api";

// Relationship type enum
const RelationshipType = {
  SELF: "SELF",
  PARTNER: "PARTNER",
  CHILD: "CHILD",
  OTHER_RELATIVE: "OTHER_RELATIVE",
  FRIEND: "FRIEND",
  COLLEAGUE: "COLLEAGUE",
  OTHER: "OTHER",
} as const;

type RelationshipTypeValue = typeof RelationshipType[keyof typeof RelationshipType];

interface ExtendedUser extends User {
  name?: string;
  profilePictureUrl?: string | null;
  birthDate?: string | null;
  relationshipType?: RelationshipTypeValue;
  preferredLocale?: string;
  role?: string;
  status?: 'active' | 'pending' | 'inactive';
  lastLogin?: string;
}

export default function UserManagementPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [searchTerm, setSearchTerm] = useState("");
  const [relationshipFilter, setRelationshipFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showAddUserDialog, setShowAddUserDialog] = useState(false);
  const [showEditUserDialog, setShowEditUserDialog] = useState(false);
  const [users, setUsers] = useState<ExtendedUser[]>([]);
  const [currentUser, setCurrentUser] = useState<ExtendedUser | null>(null);
  
  const [newUser, setNewUser] = useState<UserCreateRequest>({
    email: "",
    password: "",
    name: "",
    role: "member",
    relationshipType: RelationshipType.FRIEND,
    preferredLocale: "en-US",
  });

  // Fetch users on component mount
  useEffect(() => {
    const fetchUsers = async () => {
      try {
        const response = await api.getUsers();
        setUsers(response);
      } catch (error) {
        console.error("Failed to fetch users:", error);
        toast({
          title: t('common.error'),
          description: t('userManagement.userCreateFailed'),
          variant: "destructive",
        });
      }
    };

    fetchUsers();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t changes reference on every render; translations are stable within a session
  }, [toast]);

  // Filter users based on filters
  const filteredUsers = users.filter(
    (user) => {
      // Search filter
      const matchesSearch = 
        (user.name?.toLowerCase() || "").includes(searchTerm.toLowerCase()) ||
        user.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (user.role && user.role.toLowerCase().includes(searchTerm.toLowerCase()));
      
      // Relationship filter
      const matchesRelationship = relationshipFilter === "all" || 
        user.relationshipType === relationshipFilter;
      
      // Status filter
      const matchesStatus = statusFilter === "all" || 
        user.status === statusFilter;
        
      return matchesSearch && matchesRelationship && matchesStatus;
    }
  );

  // Handle adding a new user
  const handleAddUser = async () => {
    try {
      const response = await api.createUser(newUser);
      
      setUsers([
        ...users,
        {
          ...response,
          status: "active",
        }
      ]);

      toast({
        title: t('userManagement.userCreated'),
        description: t('userManagement.userCreatedDetail', { name: newUser.name || newUser.email }),
      });

      // Reset and close dialog
      setShowAddUserDialog(false);
      setNewUser({
        email: "",
        password: "",
        name: "",
        role: "member",
        relationshipType: RelationshipType.FRIEND,
        preferredLocale: "en-US",
      });
    } catch (error) {
      console.error("Error creating user:", error);
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('userManagement.userCreateFailed'),
        variant: "destructive",
      });
    }
  };

  // Handle updating a user
  const handleUpdateUser = async () => {
    try {
      if (!currentUser?.id) {
        throw new Error("No user ID found");
      }

      const updateData: UserUpdateRequest = {
        name: currentUser.name,
        profilePictureUrl: currentUser.profilePictureUrl || undefined,
        birthDate: currentUser.birthDate || undefined,
        relationshipType: currentUser.relationshipType,
        preferredLocale: currentUser.preferredLocale,
        role: currentUser.role,
      };

      const response = await api.updateUser(currentUser.id, updateData);
      
      setUsers(users.map(user => 
        user.id === currentUser.id ? { ...user, ...response } : user
      ));
      
      toast({
        title: t('userManagement.userUpdated'),
        description: t('userManagement.userUpdatedDetail', { name: currentUser.name || currentUser.email }),
      });
      
      // Reset and close dialog
      setShowEditUserDialog(false);
      setCurrentUser(null);
    } catch (error) {
      console.error("Error updating user:", error);
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('userManagement.userUpdateFailed'),
        variant: "destructive",
      });
    }
  };

  // Handle deleting a user
  const handleDeleteUser = async (userId: string) => {
    try {
      await api.deleteUser(userId);
      
      setUsers(users.filter(user => user.id !== userId));
      
      toast({
        title: t('userManagement.userRemoved'),
        description: t('userManagement.userRemovedDetail'),
      });
    } catch (error) {
      console.error("Error removing user:", error);
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('userManagement.userRemoveFailed'),
        variant: "destructive",
      });
    }
  };

  // Handle resending invitation
  const handleResendInvitation = async (userId: string) => {
    try {
      const user = users.find(u => u.id === userId);
      
      if (!user) {
        throw new Error("User not found");
      }
      
      // TODO: Implement resend invitation endpoint
      // await api.resendInvitation(userId);
      
      toast({
        title: t('userManagement.invitationSent'),
        description: t('userManagement.invitationSentDetail', { email: user.email }),
      });
    } catch (error) {
      console.error("Error resending invitation:", error);
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('userManagement.invitationFailed'),
        variant: "destructive",
      });
    }
  };

  // Get relationship label
  const getRelationshipLabel = (type?: RelationshipTypeValue) => {
    if (!type) return t('userManagement.relationOther');

    switch (type) {
      case RelationshipType.SELF:
        return t('userManagement.relationSelf');
      case RelationshipType.PARTNER:
        return t('userManagement.relationPartner');
      case RelationshipType.CHILD:
        return t('userManagement.relationChild');
      case RelationshipType.OTHER_RELATIVE:
        return t('userManagement.relationRelative');
      case RelationshipType.FRIEND:
        return t('userManagement.relationFriend');
      case RelationshipType.COLLEAGUE:
        return t('userManagement.relationColleague');
      default:
        return t('userManagement.relationOther');
    }
  };

  // Get role badge style
  const getRoleBadgeStyle = (role?: string) => {
    switch (role) {
      case "owner":
        return "bg-brand-primary/10 text-brand-primary border-brand-primary/20 hover:bg-brand-primary/10";
      case "admin":
        return "bg-brand-primary/10 text-brand-primary border-brand-primary/20 hover:bg-brand-primary/10";
      case "viewer":
      case "readonly":
        return "bg-muted text-muted-foreground hover:bg-muted";
      default:
        return "bg-muted text-muted-foreground hover:bg-muted";
    }
  };

  // Get status badge style
  const getStatusBadgeStyle = (status?: string) => {
    switch (status) {
      case "active":
        return "bg-positive/10 text-positive border-positive/20 hover:bg-positive/10";
      case "pending":
        return "bg-warning/10 text-warning border-warning/20 hover:bg-warning/10";
      case "inactive":
        return "bg-muted text-muted-foreground hover:bg-muted";
      default:
        return "bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/10";
    }
  };

  return (
    <div className="container mx-auto py-6">
      <div className="flex flex-col space-y-8">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center mb-2">
              <Link to="/settings">
                <Button variant="ghost" size="icon" className="mr-2">
                  <ArrowLeft className="h-5 w-5" />
                </Button>
              </Link>
              <h2 className="text-3xl font-bold tracking-tight">{t('userManagement.title')}</h2>
            </div>
            <p className="text-muted-foreground">
              {t('userManagement.subtitle')}
            </p>
          </div>
          <Dialog open={showAddUserDialog} onOpenChange={setShowAddUserDialog}>
            <DialogTrigger asChild>
              <Button>
                <UserPlus className="mr-2 h-4 w-4" />
                {t('userManagement.createUser')}
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[500px]">
              <DialogHeader>
                <DialogTitle>{t('userManagement.createTitle')}</DialogTitle>
                <DialogDescription>
                  {t('userManagement.createDescription')}
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-6 py-4">
                <div className="grid grid-cols-1 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="name">{t('userManagement.name')}</Label>
                    <Input
                      id="name"
                      placeholder={t('userManagement.namePlaceholder')}
                      value={newUser.name}
                      onChange={(e) => setNewUser({ ...newUser, name: e.target.value })}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="email">{t('userManagement.emailAddress')}</Label>
                    <Input
                      id="email"
                      type="email"
                      placeholder={t('userManagement.emailPlaceholder')}
                      value={newUser.email}
                      onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="password">{t('userManagement.password')}</Label>
                    <Input
                      id="password"
                      type="password"
                      placeholder={t('userManagement.passwordPlaceholder')}
                      value={newUser.password}
                      onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="create-role">{t('userManagement.role')}</Label>
                    <Select
                      value={newUser.role || "member"}
                      onValueChange={(value) => setNewUser({ ...newUser, role: value })}
                    >
                      <SelectTrigger id="create-role">
                        <SelectValue placeholder={t('userManagement.selectRole')} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="admin">
                          <div className="flex items-center gap-2">
                            <Shield className="h-4 w-4" />
                            {t('userManagement.roleAdmin')}
                          </div>
                        </SelectItem>
                        <SelectItem value="member">{t('userManagement.roleMember')}</SelectItem>
                        <SelectItem value="viewer">
                          <div className="flex items-center gap-2">
                            <Eye className="h-4 w-4" />
                            {t('userManagement.roleViewer')}
                          </div>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="locale">{t('userManagement.preferredLanguage')}</Label>
                    <Select
                      value={newUser.preferredLocale}
                      onValueChange={(value) => setNewUser({ ...newUser, preferredLocale: value })}
                    >
                      <SelectTrigger id="locale">
                        <SelectValue placeholder={t('userManagement.selectLanguage')} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="en-US">English (US)</SelectItem>
                        <SelectItem value="en-GB">English (UK)</SelectItem>
                        <SelectItem value="es">Spanish</SelectItem>
                        <SelectItem value="fr">French</SelectItem>
                        <SelectItem value="de">German</SelectItem>
                        <SelectItem value="pt-BR">Portuguese (Brazil)</SelectItem>
                        <SelectItem value="ja">Japanese</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button type="submit" onClick={handleAddUser} disabled={!newUser.email || !newUser.password || newUser.password.length < 6}>
                  <UserPlus className="mr-2 h-4 w-4" />
                  {t('userManagement.createUser')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Edit User Dialog — always mounted so Radix can finish its close animation
              and clean up aria-hidden before currentUser is cleared */}
          <Dialog
            open={showEditUserDialog}
            onOpenChange={(open) => {
              setShowEditUserDialog(open);
              if (!open) setCurrentUser(null);
            }}
          >
            <DialogContent className="sm:max-w-[500px]">
              <DialogHeader>
                <DialogTitle>{t('userManagement.editTitle')}</DialogTitle>
                <DialogDescription>
                  {t('userManagement.editDescription')}
                </DialogDescription>
              </DialogHeader>
              {currentUser && (
                <>
                  <div className="grid gap-6 py-4">
                    <div className="flex items-center justify-center">
                      <Avatar className="h-24 w-24">
                        {currentUser.profilePictureUrl ? (
                          <AvatarImage src={currentUser.profilePictureUrl} />
                        ) : (
                          <AvatarFallback className="text-lg">
                            {currentUser.name?.charAt(0) || ''}
                          </AvatarFallback>
                        )}
                      </Avatar>
                    </div>

                    <div className="grid grid-cols-1 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="edit-name">{t('userManagement.name')}</Label>
                        <Input
                          id="edit-name"
                          value={currentUser.name || ''}
                          onChange={(e) => setCurrentUser({ ...currentUser, name: e.target.value })}
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="edit-email">{t('userManagement.emailAddress')}</Label>
                        <Input
                          id="edit-email"
                          type="email"
                          value={currentUser.email || ''}
                          onChange={(e) => setCurrentUser({ ...currentUser, email: e.target.value })}
                          disabled={currentUser.role === "owner"}
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="edit-locale">{t('userManagement.preferredLanguage')}</Label>
                        <Select
                          value={currentUser.preferredLocale || ''}
                          onValueChange={(value) => setCurrentUser({ ...currentUser, preferredLocale: value })}
                        >
                          <SelectTrigger id="edit-locale">
                            <SelectValue placeholder={t('userManagement.selectLanguage')} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="en-US">English (US)</SelectItem>
                            <SelectItem value="en-GB">English (UK)</SelectItem>
                            <SelectItem value="es">Spanish</SelectItem>
                            <SelectItem value="fr">French</SelectItem>
                            <SelectItem value="de">German</SelectItem>
                            <SelectItem value="pt-BR">Portuguese (Brazil)</SelectItem>
                            <SelectItem value="ja">Japanese</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="birthDate">{t('userManagement.birthDate')}</Label>
                        <Input
                          id="birthDate"
                          type="date"
                          value={currentUser.birthDate ? new Date(currentUser.birthDate).toISOString().split('T')[0] : ''}
                          onChange={(e) => {
                            const date = e.target.value ? new Date(e.target.value) : null;
                            setCurrentUser({ ...currentUser, birthDate: date?.toISOString().split('T')[0] });
                          }}
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="edit-role">{t('userManagement.role')}</Label>
                        <Select
                          value={currentUser.role || 'member'}
                          onValueChange={(value) => setCurrentUser({ ...currentUser, role: value })}
                        >
                          <SelectTrigger id="edit-role">
                            <SelectValue placeholder={t('userManagement.selectRole')} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="admin">
                              <div className="flex items-center gap-2">
                                <Shield className="h-4 w-4" />
                                {t('userManagement.roleAdmin')}
                              </div>
                            </SelectItem>
                            <SelectItem value="member">{t('userManagement.roleMember')}</SelectItem>
                            <SelectItem value="viewer">
                              <div className="flex items-center gap-2">
                                <Eye className="h-4 w-4" />
                                {t('userManagement.roleViewer')}
                              </div>
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </div>
                  <DialogFooter className="flex justify-between">
                    <Button
                      variant="outline"
                      className="gap-2"
                      onClick={() => {
                        setShowEditUserDialog(false);
                        setCurrentUser(null);
                      }}
                    >
                      {t('userManagement.cancel')}
                    </Button>
                    <Button onClick={handleUpdateUser} disabled={!currentUser.name || !currentUser.email}>
                      <UserCog className="mr-2 h-4 w-4" />
                      {t('userManagement.updateUser')}
                    </Button>
                  </DialogFooter>
                </>
              )}
            </DialogContent>
          </Dialog>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{t('userManagement.tenantUsers')}</CardTitle>
            <CardDescription>
              {t('userManagement.tenantUsersDescription')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="mb-6 space-y-4">
              <div className="flex flex-col sm:flex-row justify-between gap-3">
                <Input
                  placeholder={t('userManagement.searchUsers')}
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="max-w-sm"
                />
                <div className="flex flex-wrap gap-2">

                  
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" className="h-10 gap-1">
                        <Filter className="h-4 w-4" />
                        <span>{t('userManagement.statusFilter')}</span>
                        <ChevronDown className="h-4 w-4 opacity-50" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuLabel>{t('userManagement.statusFilter')}</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => setStatusFilter("all")}>
                        {t('userManagement.allStatuses')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setStatusFilter("active")}>
                        {t('userManagement.statusActive')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setStatusFilter("pending")}>
                        {t('userManagement.statusPending')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setStatusFilter("inactive")}>
                        {t('userManagement.statusInactive')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
              
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">
                  {t('userManagement.showing')} {filteredUsers.length} {t('userManagement.of')} {users.length} {t('userManagement.users')}
                </span>

                {statusFilter !== "all" && (
                  <Badge variant="outline" className="flex items-center gap-1">
                    <span>{t('userManagement.statusFilter')}: {statusFilter}</span>
                    <button 
                      className="ml-1 hover:text-destructive" 
                      onClick={() => setStatusFilter("all")}
                    >
                      <X size={14} />
                    </button>
                  </Badge>
                )}
              </div>
            </div>
            
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('userManagement.user')}</TableHead>
                    <TableHead>{t('userManagement.role')}</TableHead>
                    <TableHead>{t('userManagement.statusFilter')}</TableHead>
                    <TableHead>{t('userManagement.lastLogin')}</TableHead>
                    <TableHead className="text-right">{t('common.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredUsers.length > 0 ? (
                    filteredUsers.map((user) => (
                      <TableRow key={user.id}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <Avatar>
                              {user.profilePictureUrl ? (
                                <AvatarImage src={user.profilePictureUrl} />
                              ) : (
                                <AvatarFallback>
                                  {user.name?.charAt(0) || ''}
                                </AvatarFallback>
                              )}
                            </Avatar>
                            <div className="font-medium flex flex-col">
                              {user.name || user.email}
                              {user.preferredLocale && (
                                <span className="text-xs text-muted-foreground flex items-center mt-1">
                                  <GlobeLock className="h-3 w-3 mr-1" />
                                  {user.preferredLocale}
                                </span>
                              )}
                            </div>
                          </div>
                        </TableCell>

                        <TableCell>
                          <Badge
                            className={`capitalize ${getRoleBadgeStyle(user.role)}`}
                          >
                            {user.role || 'member'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge
                            className={`capitalize ${getStatusBadgeStyle(user.status)}`}
                          >
                            {user.status}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {user.lastLogin ? (
                            formatDate(user.lastLogin)
                          ) : (
                            <span className="text-muted-foreground">{t('userManagement.never')}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <DropdownMenu modal={false}>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuLabel>{t('common.actions')}</DropdownMenuLabel>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => {
                                  setCurrentUser(user);
                                  setShowEditUserDialog(true);
                                }}
                              >
                                <Pencil className="h-4 w-4 mr-2" />
                                {t('userManagement.editUser')}
                              </DropdownMenuItem>
                              {user.status === "pending" && (
                                <DropdownMenuItem
                                  onClick={() => handleResendInvitation(user.id || '')}
                                >
                                  <Mail className="h-4 w-4 mr-2" />
                                  {t('userManagement.resendInvitation')}
                                </DropdownMenuItem>
                              )}
                              {user.role !== "owner" && (
                                <DropdownMenuItem
                                  className="text-destructive"
                                  onClick={() => handleDeleteUser(user.id || '')}
                                >
                                  <Trash2 className="h-4 w-4 mr-2" />
                                  {t('userManagement.removeUser')}
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={4} className="h-24 text-center">
                        {t('userManagement.noUsersFound')}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
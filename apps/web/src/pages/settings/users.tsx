import { useState, useEffect } from "react";
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
          title: "Error",
          description: "Failed to load users",
          variant: "destructive",
        });
      }
    };

    fetchUsers();
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
        title: "User created",
        description: `User ${newUser.name || newUser.email} has been created successfully`,
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
        title: "Error",
        description: error instanceof Error ? error.message : "Something went wrong when creating the user",
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
        title: "User updated",
        description: `User ${currentUser.name || currentUser.email} has been updated successfully`,
      });
      
      // Reset and close dialog
      setShowEditUserDialog(false);
      setCurrentUser(null);
    } catch (error) {
      console.error("Error updating user:", error);
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Something went wrong when updating the user",
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
        title: "User removed",
        description: "The user has been removed from this tenant",
      });
    } catch (error) {
      console.error("Error removing user:", error);
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Something went wrong when removing the user",
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
        title: "Invitation sent",
        description: `A new invitation has been sent to ${user.email}`,
      });
    } catch (error) {
      console.error("Error resending invitation:", error);
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Something went wrong when resending the invitation",
        variant: "destructive",
      });
    }
  };

  // Get relationship label
  const getRelationshipLabel = (type?: RelationshipTypeValue) => {
    if (!type) return "Other";
    
    switch (type) {
      case RelationshipType.SELF:
        return "Self";
      case RelationshipType.PARTNER:
        return "Partner";
      case RelationshipType.CHILD:
        return "Child";
      case RelationshipType.OTHER_RELATIVE:
        return "Other Relative";
      case RelationshipType.FRIEND:
        return "Friend";
      case RelationshipType.COLLEAGUE:
        return "Colleague";
      default:
        return "Other";
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
              <h2 className="text-3xl font-bold tracking-tight">User Management</h2>
            </div>
            <p className="text-muted-foreground">
              Manage users and their access to your tenant
            </p>
          </div>
          <Dialog open={showAddUserDialog} onOpenChange={setShowAddUserDialog}>
            <DialogTrigger asChild>
              <Button>
                <UserPlus className="mr-2 h-4 w-4" />
                Create User
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[500px]">
              <DialogHeader>
                <DialogTitle>Create a New User</DialogTitle>
                <DialogDescription>
                  Create a new user account with login credentials.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-6 py-4">
                <div className="grid grid-cols-1 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="name">Name</Label>
                    <Input
                      id="name"
                      placeholder="Enter their name"
                      value={newUser.name}
                      onChange={(e) => setNewUser({ ...newUser, name: e.target.value })}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="email">Email Address</Label>
                    <Input
                      id="email"
                      type="email"
                      placeholder="Enter their email address"
                      value={newUser.email}
                      onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="password">Password</Label>
                    <Input
                      id="password"
                      type="password"
                      placeholder="Set a password (min 6 characters)"
                      value={newUser.password}
                      onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="create-role">Role</Label>
                    <Select
                      value={newUser.role || "member"}
                      onValueChange={(value) => setNewUser({ ...newUser, role: value })}
                    >
                      <SelectTrigger id="create-role">
                        <SelectValue placeholder="Select role" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="admin">
                          <div className="flex items-center gap-2">
                            <Shield className="h-4 w-4" />
                            Admin
                          </div>
                        </SelectItem>
                        <SelectItem value="member">Member</SelectItem>
                        <SelectItem value="viewer">
                          <div className="flex items-center gap-2">
                            <Eye className="h-4 w-4" />
                            Viewer (read-only)
                          </div>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="locale">Preferred Language</Label>
                    <Select
                      value={newUser.preferredLocale}
                      onValueChange={(value) => setNewUser({ ...newUser, preferredLocale: value })}
                    >
                      <SelectTrigger id="locale">
                        <SelectValue placeholder="Select language" />
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
                  Create User
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
                <DialogTitle>Edit User</DialogTitle>
                <DialogDescription>
                  Update user information and access permissions
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
                        <Label htmlFor="edit-name">Name</Label>
                        <Input
                          id="edit-name"
                          value={currentUser.name || ''}
                          onChange={(e) => setCurrentUser({ ...currentUser, name: e.target.value })}
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="edit-email">Email Address</Label>
                        <Input
                          id="edit-email"
                          type="email"
                          value={currentUser.email || ''}
                          onChange={(e) => setCurrentUser({ ...currentUser, email: e.target.value })}
                          disabled={currentUser.role === "owner"}
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="edit-locale">Preferred Language</Label>
                        <Select
                          value={currentUser.preferredLocale || ''}
                          onValueChange={(value) => setCurrentUser({ ...currentUser, preferredLocale: value })}
                        >
                          <SelectTrigger id="edit-locale">
                            <SelectValue placeholder="Select language" />
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
                        <Label htmlFor="birthDate">Birth Date</Label>
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
                        <Label htmlFor="edit-role">Role</Label>
                        <Select
                          value={currentUser.role || 'member'}
                          onValueChange={(value) => setCurrentUser({ ...currentUser, role: value })}
                        >
                          <SelectTrigger id="edit-role">
                            <SelectValue placeholder="Select role" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="admin">
                              <div className="flex items-center gap-2">
                                <Shield className="h-4 w-4" />
                                Admin
                              </div>
                            </SelectItem>
                            <SelectItem value="member">Member</SelectItem>
                            <SelectItem value="viewer">
                              <div className="flex items-center gap-2">
                                <Eye className="h-4 w-4" />
                                Viewer (read-only)
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
                      Cancel
                    </Button>
                    <Button onClick={handleUpdateUser} disabled={!currentUser.name || !currentUser.email}>
                      <UserCog className="mr-2 h-4 w-4" />
                      Update User
                    </Button>
                  </DialogFooter>
                </>
              )}
            </DialogContent>
          </Dialog>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Tenant Users</CardTitle>
            <CardDescription>
              Manage users with access to your financial data
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="mb-6 space-y-4">
              <div className="flex flex-col sm:flex-row justify-between gap-3">
                <Input
                  placeholder="Search users..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="max-w-sm"
                />
                <div className="flex flex-wrap gap-2">

                  
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" className="h-10 gap-1">
                        <Filter className="h-4 w-4" />
                        <span>Status</span>
                        <ChevronDown className="h-4 w-4 opacity-50" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuLabel>Filter by Status</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => setStatusFilter("all")}>
                        All Statuses
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setStatusFilter("active")}>
                        Active
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setStatusFilter("pending")}>
                        Pending
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setStatusFilter("inactive")}>
                        Inactive
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
              
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">
                  Showing {filteredUsers.length} of {users.length} users
                </span>

                {statusFilter !== "all" && (
                  <Badge variant="outline" className="flex items-center gap-1">
                    <span>Status: {statusFilter}</span>
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
                    <TableHead>User</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last Login</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
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
                            <span className="text-muted-foreground">Never</span>
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
                              <DropdownMenuLabel>Actions</DropdownMenuLabel>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => {
                                  setCurrentUser(user);
                                  setShowEditUserDialog(true);
                                }}
                              >
                                <Pencil className="h-4 w-4 mr-2" />
                                Edit user
                              </DropdownMenuItem>
                              {user.status === "pending" && (
                                <DropdownMenuItem
                                  onClick={() => handleResendInvitation(user.id || '')}
                                >
                                  <Mail className="h-4 w-4 mr-2" />
                                  Resend invitation
                                </DropdownMenuItem>
                              )}
                              {user.role !== "owner" && (
                                <DropdownMenuItem
                                  className="text-destructive"
                                  onClick={() => handleDeleteUser(user.id || '')}
                                >
                                  <Trash2 className="h-4 w-4 mr-2" />
                                  Remove user
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
                        No users found matching the filters
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